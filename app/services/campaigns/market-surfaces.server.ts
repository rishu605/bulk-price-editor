/**
 * Putting a campaign on a market's prices.
 *
 * A campaign that only ever touches the base price is a campaign that does nothing for a
 * merchant selling into four markets — their EUR and JPY customers see the old price
 * while the sale runs. This is the part that fixes that, and per-market compare-at is
 * the piece the ecosystem believes cannot be done.
 *
 * The market baseline comes from one of two places, and the distinction is the same one
 * P1.2 mirrors:
 *
 *   A fixed list stores a price per variant, so its baseline is that stored price.
 *
 *   A relative list stores a percentage, so its baseline is the base baseline with the
 *   percentage applied. Mirroring those per variant would restate one number a few
 *   million times, so it is computed here from the rule instead — arithmetic on integers
 *   the mirror already holds, not a second source of truth.
 *
 * Writing fixed prices to a relative list is deliberate rather than a compromise. It
 * overrides the parent adjustment per variant for the campaign's duration, and the
 * revert deletes them so the list goes back to tracking its percentage. Writing the old
 * numbers back instead would pin prices the merchant never chose and quietly stop the
 * market following the base price at all.
 */

import prisma from "../../db.server";
import type { MarketWritePath } from "../../lib/execution/price-list-parent";
import {
  decideMarketPath,
  marketBaselines,
  planMarket,
  UnconvertedMarketError,
} from "./market-plan.server";
import { applyMarketWide, revertMarketWide } from "./market-wide.server";
import { readDerivedPrices } from "../../lib/execution/market-executor";
import { parseMoney } from "../../lib/money/money";
import {
  deleteMarketPrices,
  writeMarketPrices,
  type MarketPriceRow,
  type MarketWriteResult,
} from "../../lib/execution/market-executor";
import type { AdminClient } from "../../lib/execution/sync-executor";
import type { Guardrails, ResolvableCampaign } from "../../lib/pricing/types";
import { logger } from "../../lib/logging/logger";
import { metric } from "../../lib/telemetry/metrics";

/** Which surfaces a campaign writes to. Stored on the campaign as JSON. */
export interface CampaignSurfaces {
  base: boolean;
  /** Price list gids this campaign also prices. Empty means base only. */
  priceLists: string[];
}

export function parseSurfaces(raw: unknown): CampaignSurfaces {
  const value = (raw ?? {}) as { base?: unknown; priceLists?: unknown };
  return {
    // Base is on unless explicitly turned off. A campaign targeting only a market is
    // legitimate but unusual, and defaulting it off would silently narrow every
    // campaign created before markets existed.
    base: value.base !== false,
    priceLists: Array.isArray(value.priceLists)
      ? value.priceLists.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export interface MarketSurfaceOutcome {
  priceListGid: string;
  name: string;
  currency: string;
  verified: number;
  failed: number;
  chunks: number;
  messages: string[];
  /**
   * How this market was priced.
   *
   * Surfaced rather than kept internal because the two paths produce identical prices
   * but behave differently afterwards: a market-wide percentage keeps deriving from the
   * base price as it changes, and it is undone by restoring the merchant's own
   * percentage rather than by deleting per-product prices. A merchant reading their run
   * report is entitled to know which one happened.
   */
  path: MarketWritePath;
  /** Why the one-mutation path was not used, when it was not. */
  pathReason?: string;
}

/**
 * Runs the campaign's rule against each targeted market and writes the result.
 *
 * The rule is evaluated *on the market's own baseline* through the same planner the base
 * surface uses — not by converting the base surface's answer. That matters for more than
 * tidiness: a "set to exactly 9.99" rule has no meaningful conversion, a cost-margin rule
 * depends on a cost the market does not have, and a percentage converted after rounding
 * makes the market's discount a function of the base currency's rounding rather than of
 * the campaign. Re-resolving gets guardrails, rounding and the compare-at policy applied
 * per surface for free, which is the whole reason the resolver was written surface-first.
 */
/**
 * Records every targeted market's untouched price, before anything is written.
 *
 * This has to happen first, and it did not. The run executed the base surface, then tags,
 * then markets — and a market's baseline is captured by asking Shopify for its derived
 * price, which Shopify computes from the base price the run had just changed. So the
 * first campaign to touch a market recorded the *sale* price as that market's normal one:
 * a -20% campaign on a -10% EUR market stored €69.84 where €87.30 was the truth.
 *
 * Everything downstream then inherits it. `set-to-baseline` puts the strike-through at a
 * figure that was never the normal price, which is a false reference price on a live
 * storefront. A second campaign, a recurrence or an overlap resolves against it and
 * compounds — the precise behaviour baselines exist to make impossible.
 *
 * A relative list half-hides this, because reverting deletes the fixed prices and the
 * list goes back to tracking the restored base price. The storefront recovers and the
 * recorded baseline stays wrong, which is worse than a visible failure.
 *
 * Failures are collected rather than thrown: a market we cannot baseline is a market that
 * will not be priced, and that is not a reason to stop the base surface from running.
 */
export async function captureMarketBaselinesFirst(
  shopId: string,
  campaignId: string,
  variantGids: readonly string[],
  client: AdminClient,
): Promise<{ messages: string[]; refused: string[] }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { surfaces: true },
  });
  const surfaces = parseSurfaces(campaign?.surfaces);
  if (surfaces.priceLists.length === 0 || variantGids.length === 0) {
    return { messages: [], refused: [] };
  }

  const lists = await prisma.priceListRecord.findMany({
    where: { shopId, priceListGid: { in: surfaces.priceLists } },
  });

  const messages: string[] = [];

  // Markets that cannot be baselined, so they must not be priced later either.
  //
  // Refusing here and forgetting was the hole: the run reported "not converted", then the
  // market loop planned the same list again a few steps later. By then the base price had
  // moved, so the mirror was stale, the unconverted check no longer matched, and the
  // market was priced from a baseline derived after the campaign — the very contamination
  // #259 was about, reintroduced for exactly the market we had just declared unsafe.
  //
  // It hid because the shortcut writes a parent adjustment rather than fixed prices, and
  // the scenario counted fixed prices. Zero of them looked like "refused".
  const refused: string[] = [];

  for (const list of lists) {
    try {
      await marketBaselines(shopId, list, [...variantGids], client);
    } catch (error) {
      if (!(error instanceof UnconvertedMarketError)) throw error;
      messages.push(error.message);
      refused.push(list.priceListGid);
    }
  }

  return { messages, refused };
}

export async function applyMarketSurfaces(
  shopId: string,
  campaignId: string,
  runId: string,
  campaigns: readonly ResolvableCampaign[],
  variantGids: readonly string[],
  client: AdminClient,
  storeGuardrails?: Guardrails,
  refusedPriceListGids: readonly string[] = [],
): Promise<MarketSurfaceOutcome[]> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { surfaces: true },
  });
  const surfaces = parseSurfaces(campaign?.surfaces);
  if (surfaces.priceLists.length === 0) return [];

  const lists = await prisma.priceListRecord.findMany({
    where: { shopId, priceListGid: { in: surfaces.priceLists } },
  });

  const outcomes: MarketSurfaceOutcome[] = [];

  // A market the campaign targets that no longer exists in the mirror. Skipping it is
  // right — the run must not fail because a merchant deleted a market (E15) — but
  // skipping it in silence is not: the merchant asked for a sale in that market and
  // needs to know it did not happen, and why.
  const found = new Set(lists.map((list) => list.priceListGid));
  for (const gid of surfaces.priceLists) {
    if (found.has(gid)) continue;

    const notice = await prisma.topologyNotice.findFirst({
      where: { shopId, priceListGid: gid, kind: "removed" },
      orderBy: { createdAt: "desc" },
      select: { name: true },
    });
    const name = notice?.name ?? gid;

    outcomes.push({
      priceListGid: gid,
      name,
      currency: "",
      verified: 0,
      failed: 0,
      chunks: 0,
      messages: [
        `${name}: this market no longer exists in Shopify, so nothing was priced there. ` +
          `Everything else in this campaign ran normally. Remove it from the campaign to ` +
          `stop seeing this.`,
      ],
      path: "per-product",
      pathReason: "the market no longer exists",
    });
  }

  const refused = new Set(refusedPriceListGids);

  for (const list of lists) {
    // A market already refused before the base surface moved. Pricing it now would use a
    // baseline derived from the post-campaign base price, which is the contamination
    // #259 fixed — so it is skipped rather than re-attempted, and the reason was already
    // reported by the pre-write capture that refused it.
    if (refused.has(list.priceListGid)) {
      outcomes.push({
        priceListGid: list.priceListGid,
        name: list.name,
        currency: list.currency,
        verified: 0,
        failed: 0,
        chunks: 0,
        messages: [],
        path: "per-product",
        pathReason: "this market's prices were not converted",
      });
      continue;
    }

    // One market's failure is one market's failure.
    //
    // An unconverted price list is refused rather than priced (#257) — the number Shopify
    // returned is wrong by an exchange rate, and in a two-decimal currency it is wrong
    // while looking entirely ordinary. Letting that throw out of here would take the base
    // surface and every other market down with it, which turns one misconfigured market
    // into a campaign that did nothing and said little.
    //
    // Reported the same way a deleted market is, a few lines above: the campaign carries
    // on, and the merchant is told which market was skipped and why.
    let plan;
    try {
      plan = await planMarket(shopId, list, variantGids, campaigns, client, storeGuardrails);
    } catch (error) {
      if (!(error instanceof UnconvertedMarketError)) throw error;

      outcomes.push({
        priceListGid: list.priceListGid,
        name: list.name,
        currency: list.currency,
        verified: 0,
        failed: 0,
        chunks: 0,
        messages: [error.message],
        path: "per-product",
        pathReason: "this market's prices were not converted",
      });
      continue;
    }

    if (!plan) continue;

    const { outcome } = plan;

    if (outcome.kind === "blocked") {
      outcomes.push({
        priceListGid: list.priceListGid,
        name: list.name,
        currency: list.currency,
        verified: 0,
        failed: 0,
        chunks: 0,
        messages: [
          `${list.name}: a guardrail stopped this market before anything was written (${outcome.reason}).`,
        ],
        path: "per-product",
      });
      continue;
    }

    const rows: MarketPriceRow[] = outcome.rows
      .filter((row) => row.status !== "skipped" && row.intendedPrice)
      .map((row) => ({
        variantGid: row.ref.variantGid,
        price: row.intendedPrice!,
        // The strike-through is this market's own number, so a shopper there sees what
        // they would otherwise have paid — not a figure converted from another currency,
        // which is both wrong and obviously wrong to them.
        compareAt: row.intendedCompareAtSet ? (row.intendedCompareAt ?? null) : null,
      }));

    if (rows.length === 0) continue;

    // What this market already shows, before deciding to write anything.
    //
    // A relative price list tracks the base price, and the base surface was written
    // several steps ago — so Shopify has already moved every variant on this list by the
    // campaign's own percentage. For an ordinary percentage campaign that lands exactly
    // on the intended market price, and the correct number of mutations is none.
    //
    // Writing anyway is what made #260: the market-wide path composed the campaign's
    // percentage into the parent adjustment on top of a base price that had already moved
    // by it, so a European shopper paid 36% off a 20% sale. Asking the store first
    // removes the whole class — there is no percentage to compose if there is nothing
    // left to change.
    //
    // Read back and compared, never inferred from the rule. That is the standard rule 5
    // sets for a write, applied to a non-write: "we did nothing" must not become a way to
    // report success without having checked.
    const settled = await alreadyCorrect(client, list, rows);

    if (settled.size > 0) {
      // Ledgered even though nothing is written, because the campaign *is* the reason
      // these prices changed — it moved the base price they follow. Without a row the
      // reconciliation view cannot say which campaign put Germany on sale, and overlap
      // resolution cannot see that this campaign touched the surface at all.
      //
      // Revert needs nothing extra: reverting the base restores the market, which is the
      // same reason no write was needed here.
      const already = rows.filter((row) => settled.has(row.variantGid));
      await ledgerChunk(runId, shopId, list, already, 0);
      await prisma.variantChange.updateMany({
        where: {
          runId,
          priceListGid: list.priceListGid,
          variantGid: { in: already.map((row) => row.variantGid) },
        },
        data: { status: "VERIFIED", appliedAt: new Date(), verifiedAt: new Date() },
      });
    }

    const remaining = rows.filter((row) => !settled.has(row.variantGid));

    if (remaining.length === 0) {
      outcomes.push({
        priceListGid: list.priceListGid,
        name: list.name,
        currency: list.currency,
        verified: settled.size,
        failed: 0,
        chunks: 0,
        messages: [
          `${list.name}: already at the campaign's prices, because this market follows ` +
            `the base price. ${settled.size} verified, nothing written.`,
        ],
        path: "market-wide",
        pathReason: "this market follows the base price and was already correct",
      });
      continue;
    }

    // The same decision the review step showed the merchant, taken by the same
    // function, so the run cannot quietly do something else.
    const decision = await decideMarketPath(plan, client);

    // A parent adjustment cannot express these prices once the base surface has moved.
    //
    // The shortcut works by setting one percentage and letting Shopify derive every
    // price. But Shopify derives from the *current* base price, which this campaign has
    // already changed by its own percentage — so the only parent adjustment that
    // reproduces the intended prices is the list's existing one, unchanged. Writing
    // anything else applies the campaign twice, which is what put a European shopper on a
    // 36% discount off a 20% sale (#260).
    //
    // And leaving it unchanged is what `alreadyCorrect` above has just tested against.
    // Whatever it did not settle differs by rounding — our intended price comes from a
    // baseline that was rounded once already, Shopify's comes from rounding the whole
    // conversion at the end — and a percentage cannot close a one-minor-unit gap. Those
    // rows need explicit prices, and a parent write before them is a wrong price briefly
    // live for no benefit.
    //
    // The shortcut keeps its whole value for a markets-only campaign, which is the case
    // it was designed for and the case where the base price has not moved underneath it.
    const baseAlreadyMoved = surfaces.base;

    if (decision.path === "market-wide" && baseAlreadyMoved) {
      logger.info("market-wide skipped: base surface moved this list already", {
        runId,
        priceListGid: list.priceListGid,
        settled: settled.size,
        remaining: remaining.length,
      });
    }

    if (decision.path === "market-wide" && !baseAlreadyMoved) {
      // Write-ahead for every row first, exactly as the chunked path does. The
      // shortcut is in the number of requests, not in the ledger.
      await ledgerChunk(runId, shopId, list, rows, 0);

      const wide = await applyMarketWide({
        shopId,
        campaignId,
        runId,
        list,
        rows: outcome.rows,
        campaignBps: decision.bps,
        parent: decision.parent,
        client,
      });

      outcomes.push({
        priceListGid: list.priceListGid,
        name: list.name,
        currency: list.currency,
        verified: wide.verified,
        failed: wide.failed,
        chunks: wide.corrected > 0 ? 2 : 1,
        messages: wide.messages,
        path: "market-wide",
      });
      continue;
    }

    // `remaining`, not `rows`: anything `alreadyCorrect` settled is already at the right
    // price and already ledgered as verified. Writing it again would spend a request to
    // set a value to itself, and would re-ledger a row that is done.
    const result = await writeMarketPrices(
      client,
      list.priceListGid,
      list.currency,
      remaining,
      (chunk, index) => ledgerChunk(runId, shopId, list, chunk, index),
    );

    await recordResults(runId, shopId, list.priceListGid, result);

    const summary = summarise(list, result);
    outcomes.push({
      ...summary,
      // Rows settled without a write count as verified — they were read back from Shopify
      // and matched, which is the same evidence a written row needs.
      verified: summary.verified + settled.size,
      path: "per-product",
      pathReason:
        decision.path === "market-wide"
          ? "this market already follows the base price, so a percentage would apply the campaign twice"
          : decision.reason,
    });
  }

  return outcomes;
}

/**
 * Removes a campaign's market prices.
 *
 * Driven by the ledger rather than by recomputation, for the same reason the tag kit is:
 * a merchant who changed which surfaces a campaign targets mid-run would otherwise strand
 * prices on a market nobody is looking at any more.
 */
export async function revertMarketSurfaces(
  shopId: string,
  campaignId: string,
  client: AdminClient,
): Promise<MarketSurfaceOutcome[]> {
  // Markets repriced by a single percentage are undone by restoring the merchant's
  // own percentage, not by deleting per-product prices — there are none to delete.
  const wideMessages = await revertMarketWide(campaignId, client);

  const written = await prisma.variantChange.findMany({
    where: {
      shopId,
      surfaceKind: "MARKET",
      status: { in: ["APPLIED", "VERIFIED"] },
      run: { campaignId },
    },
    select: { variantGid: true, priceListGid: true },
  });
  // The per-product sweep still runs after a market-wide revert, and should: the
  // apply may have corrected a handful of variants with exact prices where Shopify
  // rounded differently, and those really are fixed prices that have to be deleted.
  // Deleting one that is not there is a no-op, and the ledger rows need settling
  // either way.
  if (written.length === 0) return wideOutcomes(wideMessages);

  const byList = new Map<string, string[]>();
  for (const row of written) {
    const existing = byList.get(row.priceListGid) ?? [];
    existing.push(row.variantGid);
    byList.set(row.priceListGid, existing);
  }

  const outcomes: MarketSurfaceOutcome[] = [];

  for (const [priceListGid, variantGids] of byList) {
    const list = await prisma.priceListRecord.findFirst({ where: { shopId, priceListGid } });
    const result = await deleteMarketPrices(client, priceListGid, variantGids);

    await prisma.variantChange.updateMany({
      where: { shopId, priceListGid, variantGid: { in: variantGids }, run: { campaignId } },
      data: { status: result.clean ? "REVERTED" : "FAILED" },
    });

    outcomes.push({
      ...summarise(list ?? { priceListGid, name: priceListGid, currency: "" }, result),
      path: "per-product",
    });
  }

  return [...outcomes, ...wideOutcomes(wideMessages)];
}

/** Markets that could not have their own percentage put back, as an outcome row. */
function wideOutcomes(messages: string[]): MarketSurfaceOutcome[] {
  if (messages.length === 0) return [];

  return [
    {
      priceListGid: "",
      name: "Markets",
      currency: "",
      verified: 0,
      failed: messages.length,
      chunks: 0,
      messages,
      path: "market-wide",
    },
  ];
}

/** Write-ahead, per chunk. A chunk is the smallest thing that can independently fail. */
/**
 * The rows this market already shows at the campaign's intended price.
 *
 * Only for a list with a parent adjustment: a fixed list stores its own numbers and does
 * not move when the base price does, so there is nothing to have happened already.
 *
 * Only for rows wanting no strike-through, and that exclusion is the important one. A
 * relative list has no per-variant compare-at — the parent adjustment either scales the
 * compare-at or nullifies it, and neither is "set it to what the price used to be". A row
 * needing a strike-through cannot be satisfied by doing nothing however right its price
 * looks, and treating it as settled would report a sale that shows no sale.
 */
async function alreadyCorrect(
  client: AdminClient,
  list: { priceListGid: string; currency: string; adjustmentBps: number | null },
  rows: readonly MarketPriceRow[],
): Promise<Set<string>> {
  const settled = new Set<string>();
  if (list.adjustmentBps === null) return settled;

  const candidates = rows.filter((row) => !row.compareAt);
  if (candidates.length === 0) return settled;

  const derived = await readDerivedPrices(
    client,
    list.priceListGid,
    candidates.map((row) => row.variantGid),
  );

  for (const row of candidates) {
    const live = derived.get(row.variantGid);
    if (live === undefined) continue;

    // Only a price Shopify stated in this market's own currency can be compared with what
    // the plan intends. A `RELATIVE` price comes back in the *shop's* currency (#257), and
    // comparing 18.00 USD against ¥2,629 would settle nothing — or, with the currency
    // assumed rather than read, would settle it wrongly.
    if (live.currency !== list.currency) continue;

    // A price we cannot parse is a price we have not verified. Skipping it here sends the
    // row down the ordinary write path, which is the safe direction.
    let amount: number;
    try {
      amount = parseMoney(live.amount, live.currency).amount;
    } catch {
      continue;
    }

    if (amount === row.price.amount) settled.add(row.variantGid);
  }

  return settled;
}

async function ledgerChunk(
  runId: string,
  shopId: string,
  list: { priceListGid: string; currency: string },
  chunk: readonly MarketPriceRow[],
  index: number,
): Promise<void> {
  await prisma.variantChange.createMany({
    data: chunk.map((row) => ({
      runId,
      shopId,
      variantGid: row.variantGid,
      surfaceKind: "MARKET" as const,
      priceListGid: list.priceListGid,
      currency: list.currency,
      intendedPrice: BigInt(row.price.amount),
      intendedCompareAt: row.compareAt ? BigInt(row.compareAt.amount) : null,
      intendedCompareAtSet: row.compareAt !== null && row.compareAt !== undefined,
      status: "PENDING" as const,
    })),
    skipDuplicates: true,
  });

  logger.info("market chunk ledgered", {
    runId,
    priceListGid: list.priceListGid,
    chunk: index,
    rows: chunk.length,
  });
}

async function recordResults(
  runId: string,
  shopId: string,
  priceListGid: string,
  result: MarketWriteResult,
): Promise<void> {
  const now = new Date();

  for (const status of ["verified", "failed"] as const) {
    const gids = result.rows.filter((row) => row.status === status).map((row) => row.variantGid);
    if (gids.length === 0) continue;

    await prisma.variantChange.updateMany({
      where: { runId, shopId, priceListGid, variantGid: { in: gids } },
      data: {
        status: status === "verified" ? "VERIFIED" : "FAILED",
        appliedAt: status === "verified" ? now : null,
        verifiedAt: status === "verified" ? now : null,
      },
    });
  }

  for (const row of result.rows) {
    if (!row.failureReason) continue;
    await prisma.variantChange.updateMany({
      where: { runId, shopId, priceListGid, variantGid: row.variantGid },
      data: {
        failureReason: row.guidance
          ? `${row.guidance} (Shopify said: ${row.failureReason})`
          : row.failureReason,
        attempt: { increment: 1 },
      },
    });
  }

  metric("run.rows", result.verified, { runId, surface: "market", outcome: "verified" });
  if (result.failed > 0) {
    metric("run.rows", result.failed, { runId, surface: "market", outcome: "failed" });
  }
}

function summarise(
  list: { priceListGid: string; name: string; currency: string },
  result: MarketWriteResult,
): Omit<MarketSurfaceOutcome, "path"> {
  return {
    priceListGid: list.priceListGid,
    name: list.name,
    currency: list.currency,
    verified: result.verified,
    failed: result.failed,
    chunks: result.chunks,
    messages: result.rows
      .filter((row) => row.guidance)
      .slice(0, 3)
      .map((row) => `${list.name}: ${row.guidance}`),
  };
}
