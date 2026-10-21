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
import { readContextualPrices, readDerivedPrices, readFixedPriceVariants } from "../../lib/execution/market-executor";
import { unconvertedMessage } from "../../lib/markets/conversion-check";
import { AppError } from "../../lib/errors/app-error";
import { readBaselineLadders } from "../../lib/execution/quantity-executor";
import { serialiseLadder, type LadderRung } from "../../lib/pricing/ladder-baseline";
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
import type { ResolvableCampaign } from "../../lib/pricing/types";
import { marketGuardrails } from "../../lib/markets/guardrails";
import { guardrailsFor, shopCurrency } from "../settings.server";
import { inChunks } from "../../lib/db/chunk";
import { LANDED } from "../../lib/execution/landed";
import { PRICES_MAY_BE_LIVE, type CampaignState } from "../../lib/lifecycle/transitions";

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
   *
   * Required, not optional. The preview used to load its lists without it, so before a
   * campaign's first apply every percentage-priced market fell through to the list's own
   * prices, which answer in the shop's currency, and was refused as "not converted" --
   * while the run, loading the whole row, priced it fine (#840). A caller that leaves it
   * out now fails to compile instead of previewing something the run will not do.
   */
  contextCountry: string | null;
}

export interface MarketPlan {
  shopId: string;
  list: MarketList;
  baselines: Map<string, Money>;
  outcome: PlanOutcome;
  /**
   * Variants this market is not priced for: their price here is derived from a store price
   * a campaign had already moved, so no baseline could be recorded for them (#841).
   */
  moved: string[];
  /**
   * Variants this market is not priced for because its percentage has moved since their
   * price here was recorded, and a campaign's price on them hides today's (#1093).
   */
  stale: string[];
  /**
   * The market is priced in the store's own currency, so recorded costs and the store's
   * minimum price apply to it as they do to the base price. In any other currency they
   * cannot be checked, and a cost-based guardrail leaves the market's rows alone.
   */
  inStoreCurrency: boolean;
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
): Promise<MarketPlan | null> {
  const { prices: baselines, compareAts, moved, stale } = await marketBaselines(shopId, list, [...variantGids], client);
  if (baselines.size === 0 && moved.length === 0 && stale.length === 0) return null;

  const inStoreCurrency = list.currency === (await shopCurrency(shopId));
  const costs = inStoreCurrency ? await recordedCosts(shopId, list.currency, [...baselines.keys()]) : new Map();

  const outcome = planRun({
    campaigns: [...campaigns],
    // Read here rather than handed in, so no caller can plan a market without them. The
    // run passed them and the preview did not, and a preview that shows a market priced
    // while the run skips it breaks rule 4 (#691).
    storeGuardrails: marketGuardrails(await guardrailsFor(shopId), list.currency),
    candidates: [...baselines].map(([variantGid, baseline]) => ({
      ref: {
        variantGid,
        surfaceKind: "market" as const,
        priceListGid: list.priceListGid,
        currency: baseline.currency,
      },
      // A cost is recorded in the store's currency only. A market in that currency can
      // be checked against it like the base price; in any other, a cost-based guardrail
      // has nothing to compare with and leaves the row alone (#691).
      //
      // And the compare-at, as the base surface passes its own (#1039). With none, a row no
      // campaign prices resolved to "clear the compare-at", so the revert that wrote a
      // hand-set price back took the merchant's strike-through off it.
      baseline: { price: baseline, compareAtPrice: compareAts.get(variantGid), cost: costs.get(variantGid) },
      // No mirrored live value for a relative list, and for a fixed one the stored
      // price is the baseline. Leaving it undefined means the planner writes rather
      // than deciding a row is already correct on evidence it does not have.
      livePrice: undefined,
    })),
  });

  return { shopId, list, baselines, outcome, moved, stale, inStoreCurrency };
}

/** Each variant's recorded cost, the way the base surface reads it: baseline first, then mirror. */
async function recordedCosts(
  shopId: string,
  currency: string,
  variantGids: string[],
): Promise<Map<string, Money>> {
  const [baselines, variants] = await Promise.all([
    inChunks(variantGids, (batch) =>
      prisma.baseline.findMany({
        where: { shopId, supersededAt: null, surfaceKind: "BASE", variantGid: { in: batch } },
        select: { variantGid: true, cost: true, currency: true },
      }),
    ),
    inChunks(variantGids, (batch) =>
      prisma.variantIndex.findMany({
        where: { shopId, variantGid: { in: batch } },
        select: { variantGid: true, cost: true, currency: true },
      }),
    ),
  ]);

  const out = new Map<string, Money>();
  for (const row of [...variants, ...baselines]) {
    if (row.cost === null || (row.currency && row.currency !== currency)) continue;
    // Baselines last, so a baseline's cost wins over the mirror's, as it does on the base.
    out.set(row.variantGid, money(Number(row.cost), currency));
  }
  return out;
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
): Promise<{ prices: Map<string, Money>; compareAts: Map<string, Money>; moved: string[]; stale: string[] }> {
  const stored = await prisma.baseline.findMany({
    where: {
      shopId,
      surfaceKind: "MARKET",
      priceListGid: list.priceListGid,
      supersededAt: null,
      variantGid: { in: variantGids },
    },
    select: { id: true, variantGid: true, basePrice: true, baseCompareAt: true, currency: true, handSet: true, listAdjustmentBps: true },
  });

  // Read again when the list's percentage has moved since (#1093), as far as it can be.
  const { refresh, unreadable } = await staleSetting(shopId, list, stored);
  if (refresh.length > 0) {
    await prisma.baseline.updateMany({
      where: { id: { in: refresh.map((row) => row.id) }, supersededAt: null },
      data: { supersededAt: new Date() },
    });
  }
  const dropped = new Set([...refresh, ...unreadable].map((row) => row.variantGid));
  const current = stored.filter((row) => !dropped.has(row.variantGid));

  const out = new Map<string, Money>(
    current.map((row) => [
      row.variantGid,
      money(Number(row.basePrice), row.currency || list.currency),
    ]),
  );
  // Only a fixed price carries one -- see `captureMarketBaselines`. One a campaign captured
  // before #1039 has none, and its revert clears the strike-through as it always did.
  const compareAts = new Map<string, Money>(
    current
      .filter((row) => row.baseCompareAt !== null)
      .map((row) => [row.variantGid, money(Number(row.baseCompareAt), row.currency || list.currency)]),
  );

  const stale = unreadable.map((row) => row.variantGid);
  const unread = new Set(stale);
  const missing = variantGids.filter((gid) => !out.has(gid) && !unread.has(gid));
  if (missing.length === 0) return { prices: out, compareAts, moved: [], stale };

  const moved = await movedSinceBaseline(shopId, list, missing);
  const captured = await captureMarketBaselines(
    shopId,
    list,
    missing.filter((gid) => !moved.has(gid)),
    client,
  );
  for (const [variantGid, baseline] of captured) {
    out.set(variantGid, baseline.price);
    if (baseline.compareAt) compareAts.set(variantGid, baseline.compareAt);
  }

  return { prices: out, compareAts, moved: [...moved], stale };
}

/**
 * Derived baselines this list's percentage has moved past since they were read (#1093).
 *
 * A percentage market's baseline was read once, the first time a campaign priced it, and
 * never again. A merchant who then moved the list from 10% to 30% off had every later sale
 * there computed from the 10%-off price: 20% off it was about 3% *above* the market's new
 * regular price, verified clean, with nothing said.
 *
 * `refresh`: read again now, superseded so the capture below records the price at today's
 * setting -- possible where the list derives the price right now (no fixed price on it) and
 * the store price is the one it was before any sale. A baseline with no recorded setting,
 * captured before this, is refreshed the same way when it can be, and trusted otherwise.
 *
 * `unreadable`: recorded at a different setting, and a campaign's price is on the variant
 * now, so today's regular price cannot be read. Left out of the market and said, as a
 * variant whose store price was already moved is (#841), rather than priced from a regular
 * price the market no longer has.
 */
async function staleSetting<T extends { id: string; variantGid: string; handSet: boolean | null; listAdjustmentBps: number | null }>(
  shopId: string,
  list: MarketList,
  stored: readonly T[],
): Promise<{ refresh: T[]; unreadable: T[] }> {
  // The merchant's setting, which is not the list's while a campaign's percentage is on it.
  const wide = await campaignPercentageOn(shopId, list.priceListGid);
  const setting = wide ? wide.merchants : list.adjustmentBps;
  if (setting === null) return { refresh: [], unreadable: [] };
  const derived = stored.filter((row) => row.handSet !== true && row.listAdjustmentBps !== setting);
  if (derived.length === 0) return { refresh: [], unreadable: [] };

  const gids = derived.map((row) => row.variantGid);
  const [fixedRows, moved, onSale] = await Promise.all([
    inChunks(gids, (batch) =>
      prisma.priceSurfaceEntry.findMany({
        where: { shopId, priceListGid: list.priceListGid, variantGid: { in: batch }, livePrice: { not: null } },
        select: { variantGid: true },
      }),
    ),
    movedSinceBaseline(shopId, list, gids),
    baseOnSale(shopId, gids),
  ]);
  const fixed = new Set(fixedRows.map((row) => row.variantGid));
  const readable = (row: T) =>
    !wide && !fixed.has(row.variantGid) && !moved.has(row.variantGid) && !onSale.has(row.variantGid);

  return {
    refresh: derived.filter(readable),
    // Unknown setting and unreadable now: trusted, as every baseline was before this.
    unreadable: derived.filter((row) => !readable(row) && row.listAdjustmentBps !== null),
  };
}

/**
 * A campaign's market-wide percentage on this list now, and the merchant's own setting it
 * recorded before writing it (#1094). Null when none is on it: the list's setting is the
 * merchant's.
 *
 * A campaign that prices only its markets moves the list's percentage and leaves the store
 * price alone, so nothing else here says a sale is on the prices the list derives: the store
 * price is not on sale, and once synced the mirror reports the campaign's percentage as the
 * list's. A baseline read again "at today's setting" (#1093), or first captured during the
 * sale, was then the sale price, and the next apply took its discount a second time.
 */
async function campaignPercentageOn(shopId: string, priceListGid: string): Promise<{ merchants: number | null } | null> {
  const live = await prisma.priceListChange.findFirst({
    where: { shopId, priceListGid, status: { in: ["WRITING", "APPLIED", "VERIFIED"] } },
    // The earliest still on the list, which read the merchant's setting off the list itself.
    orderBy: { createdAt: "asc" },
    select: { priorAdjustmentBps: true },
  });
  return live ? { merchants: live.priorAdjustmentBps } : null;
}

/**
 * Variants whose untouched price in this market can no longer be read (#841).
 *
 * A price derived from the store price -- a percentage list, or a B2B catalogue's rule --
 * moves when the store price does. Read after a campaign has moved the store price, it is
 * the sale price, and recording it as the market's "before" would have the campaign
 * discount it a second time: the contamination #259 was about. Every run captures market
 * baselines before it writes the store price, so this only arises for a variant whose
 * store price was already moved when its market was first priced -- a market added to a
 * running campaign, or a variant already at its sale price.
 *
 * A hand-set price on the list does not follow the store price and is always safe. So is
 * a variant whose store price still equals its baseline, or that has no baseline at all
 * (no campaign can have moved it).
 */
async function movedSinceBaseline(
  shopId: string,
  list: MarketList,
  variantGids: readonly string[],
): Promise<Set<string>> {
  if (variantGids.length === 0) return new Set();

  const [handSet, live, base] = await Promise.all([
    inChunks(variantGids, (batch) =>
      prisma.priceSurfaceEntry.findMany({
        where: { shopId, priceListGid: list.priceListGid, variantGid: { in: batch }, livePrice: { not: null } },
        select: { variantGid: true },
      }),
    ),
    inChunks(variantGids, (batch) =>
      prisma.variantIndex.findMany({
        where: { shopId, variantGid: { in: batch } },
        select: { variantGid: true, price: true },
      }),
    ),
    inChunks(variantGids, (batch) =>
      prisma.baseline.findMany({
        where: { shopId, surfaceKind: "BASE", priceListGid: "", supersededAt: null, variantGid: { in: batch } },
        select: { variantGid: true, basePrice: true },
      }),
    ),
  ]);

  const fixed = new Set(handSet.map((row) => row.variantGid));
  // A campaign's percentage on the list moves every price it derives, the store price aside,
  // and baseline or none (#1094).
  if (await campaignPercentageOn(shopId, list.priceListGid)) {
    return new Set(variantGids.filter((gid) => !fixed.has(gid)));
  }
  const livePrice = new Map(live.map((row) => [row.variantGid, row.price]));
  const moved = new Set<string>();
  for (const row of base) {
    if (fixed.has(row.variantGid)) continue;
    const now = livePrice.get(row.variantGid);
    if (now !== null && now !== undefined && now !== row.basePrice) moved.add(row.variantGid);
  }
  return moved;
}

/**
 * Variants whose store price a campaign that may still be live has written, by the ledger
 * (#1093). The mirror catches up only as a run settles, so mid-run it can still show the price
 * from before the run's own write -- and a market price read then would be the sale's, derived,
 * taken for the regular one. The newest landed or in-flight base write decides: an apply's
 * means a sale is on the store price; a revert's means it is back.
 */
async function baseOnSale(shopId: string, variantGids: readonly string[]): Promise<Set<string>> {
  const rows = await inChunks([...variantGids], (batch) =>
    prisma.variantChange.findMany({
      where: {
        shopId,
        surfaceKind: "BASE",
        priceListGid: "",
        variantGid: { in: batch },
        status: { in: ["WRITING", "APPLIED", ...LANDED] },
      },
      orderBy: [{ variantGid: "asc" }, { createdAt: "desc" }],
      distinct: ["variantGid"],
      select: { variantGid: true, run: { select: { kind: true, campaign: { select: { status: true } } } } },
    }),
  );
  return new Set(
    rows
      .filter((row) => row.run.kind !== "REVERT" && PRICES_MAY_BE_LIVE.has(row.run.campaign.status as CampaignState))
      .map((row) => row.variantGid),
  );
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
  try {
    return await readBaselineLadders(client, list.priceListGid, list.currency, variantGids);
  } catch {
    return new Map();
  }
}

/**
 * A market whose prices came back in a currency that is not its own.
 *
 * An `AppError`, and specifically not a bare `Error`, because the sentence it carries is
 * already the one a merchant should read: `unconvertedMessage` names the market, says it
 * answered in USD rather than CAD, and points at Settings → Markets. A bare `Error` has
 * no code, so `classify` fell through every pattern it knows and reported this as
 * `UNKNOWN` -- which replaces that sentence with "Something went wrong on our side" and
 * files it on the diagnostics page under the one heading that says nothing.
 *
 * Four of those are on `dartmode-labs`, recorded on 2026-09-22 before #646 stopped this
 * escaping the preview. #646 fixed where it was thrown; this fixes what it is worth when
 * it is caught, so the next call site that forgets the try/catch degrades into a message
 * a merchant can act on rather than into a shrug.
 *
 * `message` stays what it always was -- `AppError` sets `Error.message` from
 * `userMessage` -- so the call sites that push `error.message` into a refusal list are
 * unaffected.
 */
export class UnconvertedMarketError extends AppError {
  constructor(readonly priceListGid: string, readonly currency: string, message: string) {
    super({
      code: "MARKET_MISCONFIGURED",
      userMessage: message,
      // The list and the currency it should have answered in. No price values: the
      // telemetry rule in CLAUDE.md applies to error context too.
      context: { priceListGid, currency },
    });
    this.name = "UnconvertedMarketError";
  }
}

async function captureMarketBaselines(
  shopId: string,
  list: MarketList,
  variantGids: string[],
  client: AdminClient,
): Promise<Map<string, { price: Money; compareAt?: Money }>> {
  const found = new Map<string, Money>();
  // Which of those prices the merchant set by hand on the list, for the revert (#930).
  const handSet = new Set<string>();
  // And the strike-through each of those carried, which the revert writes back with the
  // price (#1039). A fixed price's only: a derived price's compare-at is the list's rule
  // applied to the store's, which the list derives again once the price is let go -- and
  // recorded, it would be pinned wherever the planner wrote the baseline as a fixed price.
  const compareAts = new Map<string, Money>();

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
    for (const gid of await readFixedPriceVariants(client, list.priceListGid, [...found.keys()])) {
      handSet.add(gid);
      // The same answer that carried the price: a hand-set price comes back with its own
      // strike-through, in the market's currency, which the check above has just confirmed.
      const compareAt = contextual.get(gid)?.compareAtAmount;
      if (compareAt) compareAts.set(gid, parseMoney(compareAt, list.currency));
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
    // `livePrice: { not: null }` is a negation, so Prisma will not split this query
    // however long the gid list is -- it fails outright with P2029 (#346).
    const entries = await inChunks(variantGids, (batch) =>
      prisma.priceSurfaceEntry.findMany({
        where: {
          shopId,
          priceListGid: list.priceListGid,
          variantGid: { in: batch },
          livePrice: { not: null },
        },
        select: { variantGid: true, livePrice: true, liveCompareAt: true, currency: true },
      }),
    );

    for (const entry of entries) {
      found.set(entry.variantGid, money(Number(entry.livePrice), entry.currency || list.currency));
      handSet.add(entry.variantGid);
      if (entry.liveCompareAt !== null) {
        compareAts.set(entry.variantGid, money(Number(entry.liveCompareAt), entry.currency || list.currency));
      }
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
        baseCompareAt: minorUnits(compareAts.get(variantGid)),
        // Null for the great majority: most wholesale variants have a single price, and
        // null says "no ladder" rather than "we did not look".
        // Cast at the boundary: Prisma's JSON input type is structurally strict and the
        // shape is already validated by `serialiseLadder`, which is the check that matters.
        quantityBreaks: (serialiseLadder(ladders.get(variantGid) ?? []) ??
          undefined) as Prisma.InputJsonValue | undefined,
        handSet: handSet.has(variantGid),
        // The setting a derived price was read at (#1093); a fixed price has none to go stale.
        listAdjustmentBps: handSet.has(variantGid) ? null : list.adjustmentBps,
        source: "AUTO_ENROLL" as const,
      })),
      skipDuplicates: true,
    });
  }

  // A variant Shopify has no price for on this market is left out rather than guessed
  // at. It simply is not priced there, which the run reports — the alternative is
  // inventing a reference price and writing a real one on top of it.
  return new Map([...found].map(([variantGid, price]) => [variantGid, { price, compareAt: compareAts.get(variantGid) }]));
}

function minorUnits(value: Money | undefined): bigint | null {
  return value ? BigInt(value.amount) : null;
}

