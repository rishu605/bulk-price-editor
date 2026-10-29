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

import { labelled, priceListLabel } from "../../lib/markets/display-name";
import prisma from "../../db.server";
import type { MarketWritePath } from "../../lib/execution/price-list-parent";
import {
  decideMarketPath,
  marketBaselines,
  planMarket,
  UnconvertedMarketError,
} from "./market-plan.server";
import { applyMarketWide, revertMarketWide } from "./market-wide.server";
import { readDerivedPrices, readFixedPriceVariants } from "../../lib/execution/market-executor";
import { parseMoney } from "../../lib/money/money";
import {
  deleteMarketPrices,
  writeMarketPrices,
  type MarketPriceRow,
  type MarketWriteResult,
} from "../../lib/execution/market-executor";
import type { AdminClient } from "../../lib/execution/sync-executor";
import type { ResolvableCampaign } from "../../lib/pricing/types";
import { describeLadderUnread, describeMarketSkips, describeMovedMarket, describeStaleSettingMarket } from "../../lib/markets/guardrails";
import { logger } from "../../lib/logging/logger";
import { metric } from "../../lib/telemetry/metrics";
import { LANDED } from "../../lib/execution/landed";
import { inChunks } from "../../lib/db/chunk";
import { tallyStatuses } from "../../lib/campaigns/run-result";
import type { PlannedRow } from "../../lib/planning/types";
import { marketsHandedTo } from "./handover.server";
import { describeBlocked } from "./blocked.server";
import { mirrorMarketDelete, mirrorMarketWrite } from "./mirror.server";
import { parseSurfaces } from "../../lib/campaigns/surfaces";

// Read here and by the planner's input alike (#1094), so it lives where both can reach it.
export { parseSurfaces, type CampaignSurfaces } from "../../lib/campaigns/surfaces";

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

  const lists = (await prisma.priceListRecord.findMany({
    where: { shopId, priceListGid: { in: surfaces.priceLists } },
  })).map(labelled);

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
      const { ladderUnread } = await marketBaselines(shopId, list, [...variantGids], client);
      // Not recorded, so not priced: said once, here, and kept out of the market step (#1103).
      if (ladderUnread) {
        messages.push(...describeLadderUnread(priceListLabel(list), true));
        refused.push(list.priceListGid);
      }
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
  refusedPriceListGids: readonly string[] = [],
  options: {
    /**
     * Never set a list's parent adjustment, only per-variant prices. For a run over named
     * variants: a percentage moves every variant on the list, not just these (#763).
     */
    perProductOnly?: boolean;
    /** Called as each chunk is written, so the run's heartbeat stays fresh (#791). */
    onProgress?: () => void | Promise<void>;
    /**
     * A run being resumed: each market leaves alone the variants whose row on that market
     * landed in it, as the base surface leaves its verified rows (#841).
     */
    alreadyLandedIn?: string;
    /**
     * A run taking variants out of the campaign: one that nobody prices here any more, and
     * whose price on the list was not the merchant's own, has its fixed price removed so it
     * follows the list again, rather than pinned at the price the list derives today (#1002).
     */
    letFollow?: boolean;
  } = {},
): Promise<MarketSurfaceOutcome[]> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { surfaces: true },
  });
  const surfaces = parseSurfaces(campaign?.surfaces);
  if (surfaces.priceLists.length === 0) return [];

  const lists = (await prisma.priceListRecord.findMany({
    where: { shopId, priceListGid: { in: surfaces.priceLists } },
  })).map(labelled);

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
        name: priceListLabel(list),
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
    const landed = options.alreadyLandedIn
      ? new Set(
          (
            await prisma.variantChange.findMany({
              where: { runId: options.alreadyLandedIn, priceListGid: list.priceListGid, status: { in: ["VERIFIED", "CLAMPED"] } },
              select: { variantGid: true },
            })
          ).map((row) => row.variantGid),
        )
      : new Set<string>();
    const todo = landed.size > 0 ? variantGids.filter((gid) => !landed.has(gid)) : variantGids;

    let plan;
    try {
      plan = await planMarket(shopId, list, todo, campaigns, client);
    } catch (error) {
      if (!(error instanceof UnconvertedMarketError)) throw error;

      outcomes.push({
        priceListGid: list.priceListGid,
        name: priceListLabel(list),
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
        name: priceListLabel(list),
        currency: list.currency,
        verified: 0,
        failed: 0,
        chunks: 0,
        // By name, as the base surface's refusal is (#1076), never the reason code.
        messages: [`${priceListLabel(list)}: ${await describeBlocked(shopId, outcome.blocked, "run")}`],
        path: "per-product",
      });
      continue;
    }

    // "Revert this variant" wrote the recomputed price as a fixed price (#1002). On a list
    // priced by a percentage that pins the variant: from then on it ignored the list and
    // stopped following the store price the way the rest of the list does. A whole revert
    // deletes the campaign's fixed price instead (#930); this does the same, for the same
    // variants -- those nobody else prices here, whose price before the campaign the list
    // derived. A hand-set one is written back below, as the whole revert writes it.
    const following = options.letFollow ? await followersAmong(shopId, list.priceListGid, outcome.rows) : [];
    if (following.length > 0) {
      const freed = await releaseFixedPrices(runId, shopId, list, following, client, options.onProgress);
      outcomes.push({
        ...summarise(list, freed),
        path: "per-product",
        pathReason: "this market's price follows the store price again",
      });
    }
    const released = new Set(following);

    const rows: MarketPriceRow[] = outcome.rows
      .filter((row) => row.status !== "skipped" && row.intendedPrice && !released.has(row.ref.variantGid))
      .map((row) => ({
        variantGid: row.ref.variantGid,
        price: row.intendedPrice!,
        // The strike-through is this market's own number, so a shopper there sees what
        // they would otherwise have paid — not a figure converted from another currency,
        // which is both wrong and obviously wrong to them.
        compareAt: row.intendedCompareAtSet ? (row.intendedCompareAt ?? null) : undefined,
      }));

    // Said out loud, and recorded even when nothing is left to write. Filtering skipped
    // rows out and moving on meant a store guardrail could take every row of a market
    // out of the sale with no outcome and no message, and the run still read as clean
    // (#691).
    const skipNotes = [
      ...describeMarketSkips(priceListLabel(list), list.currency, outcome.rows, plan.inStoreCurrency),
      ...describeMovedMarket(priceListLabel(list), plan.moved.length, plan.movedBy),
      ...describeStaleSettingMarket(priceListLabel(list), plan.stale.length),
      ...describeLadderUnread(priceListLabel(list), plan.ladderUnread),
    ];

    if (rows.length === 0) {
      if (skipNotes.length > 0) {
        outcomes.push({
          priceListGid: list.priceListGid,
          name: priceListLabel(list),
          currency: list.currency,
          verified: 0,
          failed: 0,
          chunks: 0,
          messages: skipNotes,
          path: "per-product",
          pathReason: "every variant in this market was left at full price",
        });
      }
      continue;
    }

    // The decision the review step showed the merchant, taken by the same function with the
    // same inputs, so the run cannot quietly do something else (#1109). First, so the path
    // this market is reported under is that one whether or not anything is left to write.
    const decision = await decideMarketPath(plan, client, surfaces, { perProductOnly: options.perProductOnly });

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
        name: priceListLabel(list),
        currency: list.currency,
        verified: settled.size,
        failed: 0,
        chunks: 0,
        messages: [
          `${list.name}: already at the campaign's prices, because this market follows ` +
            `the base price. ${settled.size} verified, nothing written.`,
          ...skipNotes,
        ],
        // Per product when the base price carried the campaign here (#1109), as the card
        // said: no percentage was set, and the revert's sweep settles these rows.
        path: decision.path,
        pathReason: decision.path === "per-product" ? decision.reason : undefined,
      });
      continue;
    }

    // The base price moved this list already (`decideMarketPath`), and what `alreadyCorrect`
    // did not settle differs by rounding or by the currency it was read in -- our intended
    // price comes from a baseline rounded once already, Shopify's from rounding the whole
    // conversion at the end, and a percentage cannot close a one-minor-unit gap. Those rows
    // need explicit prices, and a parent write before them would be a wrong price briefly
    // live for no benefit.
    if (decision.path === "per-product" && decision.followsBase) {
      logger.info("market-wide skipped: base surface moved this list already", {
        runId,
        priceListGid: list.priceListGid,
        settled: settled.size,
        remaining: remaining.length,
      });
    }

    if (decision.path === "market-wide") {
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
        name: priceListLabel(list),
        currency: list.currency,
        verified: wide.verified,
        failed: wide.failed,
        chunks: wide.corrected > 0 ? 2 : 1,
        messages: [...wide.messages, ...skipNotes],
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
      async (chunk, index) => {
        await ledgerChunk(runId, shopId, list, chunk, index);
        await options.onProgress?.();
      },
    );

    // The mirror first, then the ledger: a run that dies in between leaves rows the ledger
    // calls unsettled, which the mirror then calls unknown, never verified over an old price.
    await mirrorMarketWrite(shopId, list, remaining, result);
    await recordResults(runId, shopId, list.priceListGid, result);

    const summary = summarise(list, result);
    outcomes.push({
      ...summary,
      messages: [...summary.messages, ...skipNotes],
      // Rows settled without a write count as verified — they were read back from Shopify
      // and matched, which is the same evidence a written row needs.
      verified: summary.verified + settled.size,
      path: "per-product",
      pathReason: decision.reason,
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
  /** Called as each chunk is deleted, so the run's heartbeat stays fresh (#791). */
  onProgress?: () => void | Promise<void>,
  /**
   * The revert run, and every campaign but this one: what a hand-set price is recomputed
   * from and ledgered under (#930). Without it every price is deleted, as it always was.
   */
  recompute?: { runId: string; campaigns: readonly ResolvableCampaign[] },
): Promise<MarketSurfaceOutcome[]> {
  // Markets repriced by a single percentage are undone by restoring the merchant's
  // own percentage, not by deleting per-product prices — there are none to delete.
  const wideMessages = await revertMarketWide(campaignId, client);

  const written = await prisma.variantChange.findMany({
    where: {
      shopId,
      surfaceKind: "MARKET",
      status: { in: ["APPLIED", ...LANDED] },
      run: { campaignId },
    },
    select: { variantGid: true, priceListGid: true },
  });
  // And the prices another campaign's revert handed this one there (#1043), which no run of
  // this campaign's wrote: on the lists it prices now or has written. Only with somewhere to
  // ledger taking them back (I4).
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { surfaces: true } });
  const lists = [...new Set([...parseSurfaces(campaign?.surfaces).priceLists, ...written.map((row) => row.priceListGid)])];
  const handed = recompute ? await marketsHandedTo(shopId, campaignId, lists) : [];
  const own = new Set(written.map((row) => `${row.variantGid}@${row.priceListGid}`));
  const inherited = handed.filter((cell) => !own.has(`${cell.variantGid}@${cell.priceListGid}`));

  // The per-product sweep still runs after a market-wide revert, and should: the
  // apply may have corrected a handful of variants with exact prices where Shopify
  // rounded differently, and those really are fixed prices that have to be deleted.
  // Deleting one that is not there is a no-op, and the ledger rows need settling
  // either way.
  if (written.length === 0 && inherited.length === 0) return wideOutcomes(wideMessages);

  const byList = new Map<string, string[]>();
  const inheritedOn = new Map<string, Set<string>>();
  for (const row of [...written, ...inherited]) {
    const existing = byList.get(row.priceListGid) ?? [];
    existing.push(row.variantGid);
    byList.set(row.priceListGid, existing);
  }
  for (const cell of inherited) inheritedOn.set(cell.priceListGid, (inheritedOn.get(cell.priceListGid) ?? new Set()).add(cell.variantGid));

  const outcomes: MarketSurfaceOutcome[] = [];

  for (const [priceListGid, variantGids] of byList) {
    const list = await prisma.priceListRecord.findFirst({ where: { shopId, priceListGid } }).then((found) => found && labelled(found));

    // Recompute, not delete, where the price before the campaign was the merchant's own
    // (#930). Deleting a fixed price returns a variant to the list's percentage, which is
    // right for one that followed the store price and wrong for one the merchant set by
    // hand: their ¥15,000 came back as whatever the percentage derived. Such a variant is
    // planned without this campaign -- its own baseline, or another campaign's price --
    // and written back, ledgered under the revert like any other write.
    const handSet = recompute && list ? await handSetAmong(shopId, priceListGid, variantGids) : new Set<string>();
    // And where another campaign still prices the variant on this list (#1038): revert is
    // resolve(without C) (rule 6), so it gets that campaign's price, as "Revert this variant"
    // writes it (#1002) -- not the list's percentage, which deleting would have left.
    const others =
      recompute && list
        ? await pricedByOthers(shopId, list, variantGids.filter((gid) => !handSet.has(gid)), recompute.campaigns, client)
        : new Set<string>();
    const rewrite = new Set([...handSet, ...others]);
    // A handed-over price this campaign never wrote has no row of its own to settle, so it
    // is let go the way "Revert this variant" lets one go: ledgered under the revert first.
    const handedHere = inheritedOn.get(priceListGid) ?? new Set<string>();
    const released =
      recompute && list ? variantGids.filter((gid) => handedHere.has(gid) && !rewrite.has(gid)) : [];
    const followed = variantGids.filter((gid) => !rewrite.has(gid) && !handedHere.has(gid));
    const letGo = released.length > 0 ? await releaseFixedPrices(recompute!.runId, shopId, list!, released, client, onProgress) : null;

    const deleted = followed.length > 0 ? await deleteMarketPrices(client, priceListGid, followed, onProgress) : null;
    if (deleted) {
      // A deleted fixed price leaves no row behind, as the sync would mirror it (#779).
      await mirrorMarketDelete(shopId, { priceListGid, currency: list?.currency ?? "" }, deleted);
      await prisma.variantChange.updateMany({
        where: { shopId, priceListGid, variantGid: { in: followed }, run: { campaignId } },
        data: { status: deleted.clean ? "REVERTED" : "FAILED" },
      });
    }

    const restored = recompute && list && rewrite.size > 0 ? await rewriteHandSet(shopId, list, [...rewrite], recompute, client, onProgress) : null;
    if (restored) {
      await prisma.variantChange.updateMany({
        where: { shopId, priceListGid, variantGid: { in: [...rewrite] }, run: { campaignId }, NOT: { runId: recompute!.runId } },
        data: { status: restored.clean ? "REVERTED" : "FAILED" },
      });
    }

    outcomes.push({
      ...summarise(list ?? { priceListGid, name: priceListGid, currency: "" }, combine(combine(deleted, letGo), restored)),
      path: "per-product",
    });
  }

  return [...outcomes, ...wideOutcomes(wideMessages)];
}

/**
 * Which of these variants another campaign still prices on this list, planned without the
 * one being reverted (#1038). None while a campaign's percentage is on the whole list: a
 * variant whose fixed price is deleted follows it, which is that campaign's price already,
 * as `followersAmong` reasons for the per-variant revert.
 */
async function pricedByOthers(
  shopId: string,
  list: Parameters<typeof planMarket>[1],
  variantGids: readonly string[],
  campaigns: readonly ResolvableCampaign[],
  client: AdminClient,
): Promise<Set<string>> {
  if (variantGids.length === 0 || campaigns.length === 0) return new Set();
  const percentage = await prisma.priceListChange.count({
    where: { shopId, priceListGid: list.priceListGid, status: { in: ["APPLIED", "VERIFIED"] } },
  });
  if (percentage > 0) return new Set();
  const plan = await planMarket(shopId, list, [...variantGids], campaigns, client);
  if (!plan || plan.outcome.kind !== "ok") return new Set();
  return new Set(
    plan.outcome.rows
      .filter((row) => row.status !== "skipped" && row.intendedPrice && row.campaignId)
      .map((row) => row.ref.variantGid),
  );
}

/**
 * Which of these variants had a price on this list the merchant set by hand before the
 * campaign, as recorded when their market baseline was captured (#930). A revert writes those
 * back; every other one followed the list, and goes back to following it.
 */
async function handSetAmong(shopId: string, priceListGid: string, variantGids: readonly string[]): Promise<Set<string>> {
  const rows = await inChunks([...variantGids], (batch) =>
    prisma.baseline.findMany({
      where: { shopId, surfaceKind: "MARKET", priceListGid, supersededAt: null, handSet: true, variantGid: { in: batch } },
      select: { variantGid: true },
    }),
  );
  return new Set(rows.map((row) => row.variantGid));
}

/**
 * The variants a run taking them out of the campaign lets follow this list again (#1002).
 *
 * Only a planned row nobody prices: one another campaign wins is that campaign's price, and
 * is written as one. Not a hand-set price, which is written back. And none while a campaign's
 * percentage is on the whole list: a variant left to follow it would follow the sale, so it
 * is priced on its own, as it always was.
 */
async function followersAmong(shopId: string, priceListGid: string, rows: readonly PlannedRow[]): Promise<string[]> {
  // Pending only: a row a guardrail clamped is at the guardrail's price, not the list's.
  const unpriced = rows.filter((row) => row.status === "pending" && row.intendedPrice && !row.campaignId).map((row) => row.ref.variantGid);
  if (unpriced.length === 0) return [];

  const percentage = await prisma.priceListChange.count({
    where: { shopId, priceListGid, status: { in: ["APPLIED", "VERIFIED"] } },
  });
  if (percentage > 0) return [];

  const handSet = await handSetAmong(shopId, priceListGid, unpriced);
  return unpriced.filter((gid) => !handSet.has(gid));
}

/**
 * Removes fixed prices so these variants follow the list again, and reads the list back to
 * confirm it (#1002).
 *
 * Ledgered first (I4): a delete changes what a shopper pays as surely as a write. The row has
 * no intended price, because there is none -- the list derives it -- and the run's own ledger
 * is what says this market was put back, so "Revert this variant" can name it. Verified only
 * once the list no longer holds a fixed price for the variant (rule 5): the delete's answer is
 * Shopify accepting the request, and a read is what shows it took.
 */
async function releaseFixedPrices(
  runId: string,
  shopId: string,
  list: { priceListGid: string; name: string; currency: string },
  variantGids: readonly string[],
  client: AdminClient,
  onProgress?: () => void | Promise<void>,
): Promise<MarketWriteResult> {
  await prisma.variantChange.createMany({
    data: variantGids.map((variantGid) => ({
      runId,
      shopId,
      variantGid,
      surfaceKind: "MARKET" as const,
      priceListGid: list.priceListGid,
      currency: list.currency,
      intendedPrice: null,
      intendedCompareAt: null,
      intendedCompareAtSet: false,
      status: "PENDING" as const,
    })),
    skipDuplicates: true,
  });

  const deleted = await deleteMarketPrices(client, list.priceListGid, variantGids, onProgress);
  const answered = deleted.rows.filter((row) => row.status === "verified").map((row) => row.variantGid);

  let unconfirmed: (gid: string) => string | null = () => null;
  try {
    const still = answered.length > 0 ? await readFixedPriceVariants(client, list.priceListGid, answered) : new Set<string>();
    unconfirmed = (gid) => (still.has(gid) ? "Shopify accepted the delete, but the list still holds a fixed price for this variant." : null);
  } catch (error) {
    const reason = `The list could not be read back after the delete (${error instanceof Error ? error.message : String(error)}).`;
    unconfirmed = () => reason;
  }

  const rows = deleted.rows.map((row) => {
    const reason = row.status === "verified" ? unconfirmed(row.variantGid) : null;
    return reason
      ? {
          variantGid: row.variantGid,
          status: "failed" as const,
          failureReason: reason,
          guidance: "This variant may still have the campaign's price in this market. Press Revert this variant again to retry.",
        }
      : row;
  });
  const verified = rows.filter((row) => row.status === "verified").length;
  const result: MarketWriteResult = { rows, verified, failed: rows.length - verified, chunks: deleted.chunks, clean: verified === rows.length };

  // The mirror first, then the ledger, as a write does: a run that dies between them leaves
  // rows the mirror already calls unknown.
  await mirrorMarketDelete(shopId, list, result);
  await recordResults(runId, shopId, list.priceListGid, result);
  return result;
}

/**
 * A run's market rows that did not land: refused, or never confirmed (#1001). And the ones
 * that did, read back, which a campaign that prices only its markets counts as its verified
 * prices: it has no others (#1111).
 *
 * Bucketed by `tallyStatuses`, the one classification the run summary and the Partial banner
 * use, so the run's status cannot disagree with the page that explains it.
 */
export async function outstandingMarketRows(runId: string): Promise<{ verified: number; failed: number; unverified: number }> {
  const byStatus = await prisma.variantChange.groupBy({
    by: ["status"],
    where: { runId, surfaceKind: { not: "BASE" }, priceListGid: { not: "" } },
    _count: { _all: true },
  });
  const counts = tallyStatuses(byStatus.map((entry) => ({ status: entry.status, count: entry._count._all })));
  return { verified: counts.verified + counts.clamped, failed: counts.failed, unverified: counts.unverified + counts.sent + counts.pending };
}

/**
 * A revert's hand-set market prices, planned without the campaign and written back (#930).
 * Ledgered before the write and read back, as every price is (I4, rule 5).
 */
async function rewriteHandSet(
  shopId: string,
  list: { priceListGid: string; name: string; currency: string; adjustmentBps: number | null; contextCountry: string | null; catalogTitle?: string | null; surfaceKind?: string },
  variantGids: string[],
  recompute: { runId: string; campaigns: readonly ResolvableCampaign[] },
  client: AdminClient,
  onProgress?: () => void | Promise<void>,
): Promise<MarketWriteResult | null> {
  const plan = await planMarket(shopId, list, variantGids, recompute.campaigns, client);
  if (!plan || plan.outcome.kind !== "ok") return null;
  const rows: MarketPriceRow[] = plan.outcome.rows
    .filter((row) => row.status !== "skipped" && row.intendedPrice)
    .map((row) => ({
      variantGid: row.ref.variantGid,
      price: row.intendedPrice!,
      // As the apply path writes it: set or cleared when the plan decides it, left alone
      // when it does not.
      compareAt: row.intendedCompareAtSet ? (row.intendedCompareAt ?? null) : undefined,
    }));
  if (rows.length === 0) return null;
  const result = await writeMarketPrices(client, list.priceListGid, list.currency, rows, async (chunk, index) => {
    await ledgerChunk(recompute.runId, shopId, list, chunk, index);
    await onProgress?.();
  });
  await mirrorMarketWrite(shopId, list, rows, result);
  await recordResults(recompute.runId, shopId, list.priceListGid, result);
  return result;
}

/** One market's deletes and rewrites, as one result. */
function combine(a: MarketWriteResult | null, b: MarketWriteResult | null): MarketWriteResult {
  const empty: MarketWriteResult = { rows: [], verified: 0, failed: 0, chunks: 0, clean: true };
  const [x, y] = [a ?? empty, b ?? empty];
  return {
    rows: [...x.rows, ...y.rows],
    verified: x.verified + y.verified,
    failed: x.failed + y.failed,
    chunks: x.chunks + y.chunks,
    clean: x.clean && y.clean,
  };
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
      intendedCompareAtSet: row.compareAt !== undefined,
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
    name: priceListLabel(list),
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
