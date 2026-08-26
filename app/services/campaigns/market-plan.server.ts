/**
 * Planning a campaign onto a market, and choosing how to write it.
 *
 * Kept apart from the execution module because both the review step and the run need
 * these answers, and they must be the same answers. A preview that predicted the
 * per-product path while the run took the market-wide one would be telling the merchant
 * about a different campaign from the one that happens.
 */

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { readContextualPrices, readDerivedPrices } from "../../lib/execution/market-executor";
import { unconvertedMessage } from "../../lib/markets/conversion-check";
import { readLadders } from "../../lib/execution/quantity-executor";
import { parseLadder, serialiseLadder, type LadderRung } from "../../lib/pricing/ladder-baseline";
import {
  readParentState,
  type MarketWritePath,
  type ParentState,
} from "../../lib/execution/price-list-parent";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { uniformAdjustment } from "../../lib/markets/uniform";
import { money, parseMoney, type Money } from "../../lib/money/money";
import { planRun } from "../../lib/planning/plan";
import type { PlanOutcome } from "../../lib/planning/types";
import type { Guardrails, ResolvableCampaign } from "../../lib/pricing/types";

export interface MarketList {
  priceListGid: string;
  name: string;
  currency: string;
  adjustmentBps: number | null;
  /**
   * One country this list's market serves, or null when it has no market.
   *
   * `contextualPricing` is keyed by country rather than by price list, and every country
   * in a market sees the same price, so any one region answers for all of them. Null for a
   * B2B catalogue, which is priced by company location and read from the mirror instead.
   */
  contextCountry?: string | null;
}

export interface MarketPlan {
  shopId: string;
  list: MarketList;
  baselines: Map<string, Money>;
  outcome: PlanOutcome;
}

/**
 * Every live variant on the shop — what a market-wide percentage would actually move.
 *
 * Taken from the catalogue mirror rather than from the campaign's own rows, which is
 * the entire point: comparing the campaign's variants against themselves would make the
 * coverage check pass by construction and the guard would protect nothing. A market
 * catalogue can publish a subset of the catalogue, and this errs toward the larger set —
 * so the worst case is declining an optimisation, never repricing a product the
 * campaign was not pointed at.
 */
async function listCoverage(shopId: string): Promise<Set<string>> {
  const variants = await prisma.variantIndex.findMany({
    where: { shopId, deletedAt: null, status: "ACTIVE" },
    select: { variantGid: true },
  });

  return new Set(variants.map((row) => row.variantGid));
}

/**
 * Plans the campaign onto one market.
 *
 * The rule is evaluated on the market's own baseline through the same planner the base
 * surface uses — not by converting the base surface's answer. A "set to exactly 9.99"
 * rule has no meaningful conversion, a cost-margin rule depends on a cost the market
 * does not have, and a percentage converted after rounding would make the market's
 * discount a function of the base currency's rounding rather than of the campaign.
 */
export async function planMarket(
  shopId: string,
  list: MarketList,
  variantGids: readonly string[],
  campaigns: readonly ResolvableCampaign[],
  client: AdminClient,
  storeGuardrails?: Guardrails,
): Promise<MarketPlan | null> {
  const baselines = await marketBaselines(shopId, list, [...variantGids], client);
  if (baselines.size === 0) return null;

  const outcome = planRun({
    campaigns: [...campaigns],
    storeGuardrails,
    candidates: [...baselines].map(([variantGid, baseline]) => ({
      ref: {
        variantGid,
        surfaceKind: "market" as const,
        priceListGid: list.priceListGid,
        currency: baseline.currency,
      },
      baseline: { price: baseline },
      // No mirrored live value for a relative list, and for a fixed one the stored
      // price is the baseline. Leaving it undefined means the planner writes rather
      // than deciding a row is already correct on evidence it does not have.
      livePrice: undefined,
    })),
  });

  return { shopId, list, baselines, outcome };
}

export type MarketPathDecision =
  | { path: "market-wide"; bps: number; parent: ParentState }
  | { path: "per-product"; reason: string };

/**
 * Whether this market can be repriced with one mutation.
 *
 * Live state, not the mirror. The mirror refreshes on a schedule and by webhook, and a
 * merchant who set a price by hand five minutes ago is exactly the merchant whose whole
 * market must not be repriced on stale evidence.
 */
export async function decideMarketPath(
  plan: MarketPlan,
  client: AdminClient,
): Promise<MarketPathDecision> {
  if (plan.outcome.kind !== "ok") {
    return { path: "per-product", reason: "the plan did not complete" };
  }

  const parent = await readParentState(client, plan.list.priceListGid);
  if (!parent) {
    return {
      path: "per-product",
      reason: "this market's settings could not be read",
    };
  }

  const verdict = uniformAdjustment({
    rows: plan.outcome.rows,
    baselines: new Map([...plan.baselines].map(([gid, m]) => [gid, m.amount])),
    listVariantGids: await listCoverage(plan.shopId),
    hasFixedOverrides: parent.hasFixedOverrides,
  });

  return verdict.eligible
    ? { path: "market-wide", bps: verdict.bps, parent }
    : { path: "per-product", reason: verdict.reason };
}

/** Plain-language explanation of a chosen path, for the review step and run report. */
export function describePath(decision: MarketPathDecision, marketName: string): string {
  if (decision.path === "market-wide") {
    const percent = Math.abs(decision.bps) / 100;
    const rounded = Number.isInteger(percent) ? String(percent) : percent.toFixed(2);
    return (
      `${marketName} will be repriced with a single market-wide ${rounded}% change ` +
      `rather than a price per product. Prices there keep following your base prices, ` +
      `and undoing the campaign restores this market's own percentage.`
    );
  }

  return (
    `${marketName} will get a price per product, because ${decision.reason}. ` +
    `Undoing the campaign removes those prices and the market goes back to following ` +
    `your base prices.`
  );
}

export type { MarketWritePath };

/**
 * The reference price on this market, per variant — captured once, then read.
 *
 * The same rule as the base surface, for the same reason: a campaign that recomputed
 * from whatever the market currently shows would discount its own discount every time
 * it ran. Reading live is only correct until the first re-apply, and "correct until the
 * second run" is the compounding failure this product exists to prevent.
 *
 * So the first time a campaign touches a market, the market's untouched price is
 * captured into `baselines` alongside the base one and every later run computes from
 * that. Capture asks Shopify rather than deriving locally: a relative list's price is
 * the base price converted at Shopify's rate for that market and *then* adjusted, and
 * that rate is not ours to know — it moves daily and a merchant can pin it. Deriving it
 * was wrong by a factor of a hundred on the first zero-decimal market it met.
 */
export async function marketBaselines(
  shopId: string,
  list: MarketList,
  variantGids: string[],
  client: AdminClient,
): Promise<Map<string, Money>> {
  const stored = await prisma.baseline.findMany({
    where: {
      shopId,
      surfaceKind: "MARKET",
      priceListGid: list.priceListGid,
      supersededAt: null,
      variantGid: { in: variantGids },
    },
    select: { variantGid: true, basePrice: true, currency: true },
  });

  const out = new Map<string, Money>(
    stored.map((row) => [
      row.variantGid,
      money(Number(row.basePrice), row.currency || list.currency),
    ]),
  );

  const missing = variantGids.filter((gid) => !out.has(gid));
  if (missing.length === 0) return out;

  const captured = await captureMarketBaselines(shopId, list, missing, client);
  for (const [variantGid, price] of captured) out.set(variantGid, price);

  return out;
}

/**
 * Records a market's untouched prices as baselines.
 *
 * A fixed list has the number stored on the list itself; a relative list has Shopify
 * derive it. Either way this runs once per variant per market, before the campaign has
 * changed anything — which is the only moment the untouched price is observable.
 */
/**
 * The ladders a catalogue holds right now, as baseline rungs.
 *
 * A failed read yields no ladders rather than throwing. The price baseline is the thing
 * this function exists to record, and losing it because a secondary read timed out would
 * leave the campaign unable to price the market at all — a much larger failure than a
 * ladder that has to be captured on the next run.
 */
async function captureLadders(
  client: AdminClient,
  list: MarketList,
  variantGids: readonly string[],
): Promise<Map<string, LadderRung[]>> {
  if (variantGids.length === 0) return new Map();

  try {
    const raw = await readLadders(client, list.priceListGid, variantGids);
    const ladders = new Map<string, LadderRung[]>();

    for (const [variantGid, rungs] of raw) {
      const parsed = parseLadder(
        rungs.map((rung) => ({
          minimumQuantity: rung.minimumQuantity,
          amount: parseMoney(rung.amount, list.currency).amount,
        })),
        list.currency,
      );
      if (parsed) ladders.set(variantGid, parsed);
    }

    return ladders;
  } catch {
    return new Map();
  }
}

export class UnconvertedMarketError extends Error {
  constructor(readonly priceListGid: string, readonly currency: string, message: string) {
    super(message);
    this.name = "UnconvertedMarketError";
  }
}

async function captureMarketBaselines(
  shopId: string,
  list: MarketList,
  variantGids: string[],
  client: AdminClient,
): Promise<Map<string, Money>> {
  const found = new Map<string, Money>();

  // Ask Shopify what a shopper in this market pays, and take that as the baseline.
  //
  // One question, one answer, for every kind of list. `contextualPricing` is described in
  // the schema as "the final price after all adjustments are applied", so it already
  // accounts for the list's percentage *and* for any price a merchant set by hand — a
  // variant fixed at ¥1,200 comes back as ¥1,200 with its ¥1,800 strike-through. That
  // replaces reading the price list's own `prices` connection, which answered relative
  // prices in the shop's currency and made a JPY baseline 146x too low (#257).
  //
  // Authoritative in a way arithmetic cannot be. The tempting alternative — convert, then
  // apply the list's percentage — produces ¥2,629 for a market where Shopify says ¥2,921,
  // and would write a price 11% under the real one while looking like it had been read
  // from the source. Whatever Shopify says a shopper pays is what they pay.
  if (list.contextCountry) {
    const contextual = await readContextualPrices(client, variantGids, list.contextCountry);

    for (const [variantGid, price] of contextual) {
      // Still checked, because a price in the wrong currency is the one failure that looks
      // like an ordinary number. Shopify should never answer a country's context in
      // anything but that market's currency, and if it does we refuse rather than find out
      // on a storefront.
      if (price.currency !== list.currency) {
        throw new UnconvertedMarketError(
          list.priceListGid,
          list.currency,
          unconvertedMessage(list.name, list.currency, price.currency),
        );
      }

      found.set(variantGid, parseMoney(price.amount, list.currency));
    }
  } else {
    // A list with no market behind it — a B2B catalogue, priced by company location rather
    // than by country, so there is no country context to ask about.
    //
    // Hand-set prices come from the mirror, and whatever the list's rule still governs
    // comes from its own `prices` connection. That connection answers in the shop's
    // currency (#257), which for a wholesale list *is* the list's currency — there is no
    // conversion in play — so the currency check below passes and the number is right.
    // The check stays anyway: the day a B2B catalogue is priced in another currency is
    // the day this would otherwise be wrong by an exchange rate, silently.
    const entries = await prisma.priceSurfaceEntry.findMany({
      where: {
        shopId,
        priceListGid: list.priceListGid,
        variantGid: { in: variantGids },
        livePrice: { not: null },
      },
      select: { variantGid: true, livePrice: true, currency: true },
    });

    for (const entry of entries) {
      found.set(entry.variantGid, money(Number(entry.livePrice), entry.currency || list.currency));
    }

    if (list.adjustmentBps !== null) {
      const remaining = variantGids.filter((gid) => !found.has(gid));

      if (remaining.length > 0) {
        const derived = await readDerivedPrices(client, list.priceListGid, remaining);

        for (const [variantGid, price] of derived) {
          if (price.currency !== list.currency) {
            throw new UnconvertedMarketError(
              list.priceListGid,
              list.currency,
              unconvertedMessage(list.name, list.currency, price.currency),
            );
          }

          found.set(variantGid, parseMoney(price.amount, list.currency));
        }
      }
    }
  }

  // A wholesale catalogue's variants may also have a quantity ladder, and that ladder is
  // as much a part of "what this was before the campaign" as the price is. Captured here
  // because this is the same moment — before anything has been written — and reverting a
  // tiered campaign recomputes from it rather than restoring it.
  //
  // Only for a list with no country context, which is what makes it a B2B catalogue: a
  // market price list has no concept of ordering twelve.
  const ladders = list.contextCountry
    ? new Map<string, LadderRung[]>()
    : await captureLadders(client, list, [...found.keys()]);

  if (found.size > 0) {
    await prisma.baseline.createMany({
      data: [...found].map(([variantGid, price]) => ({
        shopId,
        variantGid,
        surfaceKind: "MARKET" as const,
        priceListGid: list.priceListGid,
        currency: price.currency,
        basePrice: BigInt(price.amount),
        // Null for the great majority: most wholesale variants have a single price, and
        // null says "no ladder" rather than "we did not look".
        // Cast at the boundary: Prisma's JSON input type is structurally strict and the
        // shape is already validated by `serialiseLadder`, which is the check that matters.
        quantityBreaks: (serialiseLadder(ladders.get(variantGid) ?? []) ??
          undefined) as Prisma.InputJsonValue | undefined,
        source: "AUTO_ENROLL" as const,
      })),
      skipDuplicates: true,
    });
  }

  // A variant Shopify has no price for on this market is left out rather than guessed
  // at. It simply is not priced there, which the run reports — the alternative is
  // inventing a reference price and writing a real one on top of it.
  return found;
}

