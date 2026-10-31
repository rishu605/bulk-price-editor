/**
 * The variants whose baseline was recaptured at this campaign's own sale price (#781).
 *
 * The page's status reads it, so a campaign whose baseline is its own sale price does not say
 * "every row was read back and verified"; so does the Apply confirmation, so applying it again
 * cannot discount the sale price a second time without the merchant typing the word; and so
 * does the revert report. The rule is `recapturedAtSale`, in lib/campaigns/recaptured.
 *
 * A market's or wholesale catalogue's price as well as the base price (#1166): a recapture
 * takes both from the mirror, and a market sale compounded after one as silently.
 */

import type { SurfaceKind } from "@prisma/client";

import prisma from "../../db.server";
import { inChunks } from "../../lib/db/chunk";
import { LANDED } from "../../lib/execution/landed";
import { logger } from "../../lib/logging/logger";
import { PRICES_MAY_BE_LIVE } from "../../lib/lifecycle/transitions";
import { parseSurfaces } from "../../lib/campaigns/surfaces";
import {
  marketStint,
  priceBeforeStint,
  recapturedAtSale,
  recapturedKey,
  recapturedVariants,
  sinceItEnded,
  stintOf,
  type StintRow,
} from "../../lib/campaigns/recaptured";

export interface RecapturedBaseline {
  variantGid: string;
  /** "" for the base price; otherwise the market's or wholesale catalogue's price list (#1166). */
  priceListGid: string;
  /**
   * The price before this campaign wrote it, in minor units: the ledger's for the base price,
   * and for a market's the baseline its first write was computed from (`marketBefore`).
   */
  before: bigint;
  /** The baseline now, a price this campaign wrote, in minor units. */
  baseline: bigint;
  currency: string;
  /** A market's or wholesale price's baseline set by hand, which a revert writes back (#930). False for the base price. */
  handSet: boolean;
  /**
   * Whether applying the campaign again writes this price: always for the base price, and for
   * a market's while the campaign still prices that list. One taken off it is still reverted.
   */
  targeted: boolean;
}

/** The prices a baseline is recaptured on: the base price, and every price list's (#1166). */
const PRICED: SurfaceKind[] = ["BASE", "MARKET"];

/**
 * The prices this campaign is pricing whose current baseline is a sale price it wrote,
 * recaptured while it was live, keyed by `recapturedKey`: a base price by its variant id, so
 * `has(variantGid)` asks about the base price. Of `variantGids` only, when given.
 *
 * Its applies, re-assertions and enrolments are its writes; a revert ends them. Only the
 * baselines captured since the oldest of its newest twenty runs are read, and the ledger only
 * for those, so a campaign nobody recaptured under costs a few small queries, and a draft one.
 * Not a wholesale ladder: its rows are B2B, and its rungs are not one price.
 */
export async function recapturedBaselines(
  shopId: string,
  campaignId: string,
  variantGids?: readonly string[],
): Promise<Map<string, RecapturedBaseline>> {
  const found = new Map<string, RecapturedBaseline>();
  // Since it last ended (#1166): a sale after a completed revert starts its stints afresh.
  const runs = sinceItEnded(
    await prisma.campaignRun.findMany({
      where: { shopId, campaignId, kind: { in: ["APPLY", "REASSERT", "ENROLL", "REVERT"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, kind: true, status: true, occurrenceKey: true, createdAt: true },
      take: 20,
    }),
  );
  const oldestWrite = runs.filter((run) => run.kind !== "REVERT").at(-1);
  if (!oldestWrite || variantGids?.length === 0) return found;

  const recent = {
    shopId,
    surfaceKind: { in: PRICED },
    supersededAt: null,
    capturedAt: { gt: oldestWrite.createdAt },
    // Not one a run captured for itself before writing (#1166): that is the price its write is
    // computed from, never its own sale price, and a first apply over four markets of 102,132
    // variants captures 408,528 of them, which every plan of the campaign would read again.
    source: { not: "AUTO_ENROLL" as const },
  };
  const select = {
    variantGid: true,
    surfaceKind: true,
    priceListGid: true,
    basePrice: true,
    currency: true,
    capturedAt: true,
    handSet: true,
  } as const;
  const [campaign, baselines] = await Promise.all([
    prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { excludedVariantGids: true, surfaces: true } }),
    variantGids
      ? inChunks([...variantGids], (batch) => prisma.baseline.findMany({ where: { ...recent, variantGid: { in: batch } }, select }))
      : prisma.baseline.findMany({ where: recent, select }),
  ]);
  // Let go of by "Revert this variant": no longer this campaign's (#886).
  const excluded = new Set(campaign?.excludedVariantGids ?? []);
  // A base baseline is on no price list, and a market's on one.
  const candidates = baselines.filter(
    (baseline) => !excluded.has(baseline.variantGid) && (baseline.surfaceKind === "BASE") === (baseline.priceListGid === ""),
  );
  if (candidates.length === 0) return found;

  const reverts = new Set(runs.filter((run) => run.kind === "REVERT").map((run) => run.id));
  const changes = await inChunks(
    [...new Set(candidates.map((baseline) => baseline.variantGid))],
    (batch) =>
      prisma.variantChange.findMany({
        where: {
          runId: { in: runs.map((r) => r.id) },
          // A market price a whole revert took back is REVERTED, and left out with it.
          status: { in: [...LANDED, "APPLIED"] },
          surfaceKind: { in: ["BASE", "MARKET"] },
          variantGid: { in: batch },
        },
        // Newest first, as `stintOf` reads them: a revert's row ends the writes before it.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { variantGid: true, priceListGid: true, runId: true, beforePrice: true, intendedPrice: true, createdAt: true },
      }),
  );

  const rows = new Map<string, StintRow[]>();
  for (const change of changes) {
    const key = recapturedKey(change.variantGid, change.priceListGid);
    const row = { revert: reverts.has(change.runId), before: change.beforePrice, intended: change.intendedPrice, at: change.createdAt };
    const list = rows.get(key);
    if (list) list.push(row);
    else rows.set(key, [row]);
  }

  const stints = new Map<string, StintRow[]>();
  for (const baseline of candidates) {
    const key = recapturedKey(baseline.variantGid, baseline.priceListGid);
    stints.set(key, stintOf(rows.get(key) ?? []));
  }
  // A market's rows record no price before them, so its stint is read with the baseline it
  // was written from (#1166).
  const before = await marketBefore(shopId, candidates.filter((baseline) => baseline.priceListGid !== ""), stints);
  const targeted = new Set(parseSurfaces(campaign?.surfaces).priceLists);

  for (const baseline of candidates) {
    const key = recapturedKey(baseline.variantGid, baseline.priceListGid);
    const market = baseline.priceListGid !== "";
    const stint = market ? marketStint(stints.get(key)!, before.get(key) ?? null) : stints.get(key)!;
    if (!recapturedAtSale(stint, { price: baseline.basePrice, capturedAt: baseline.capturedAt })) continue;
    found.set(key, {
      variantGid: baseline.variantGid,
      priceListGid: baseline.priceListGid,
      before: priceBeforeStint(stint)!,
      baseline: baseline.basePrice,
      currency: baseline.currency,
      handSet: market && baseline.handSet === true,
      targeted: !market || targeted.has(baseline.priceListGid),
    });
  }
  return found;
}

/**
 * The price before the campaign on a market or wholesale catalogue, by `recapturedKey`: the
 * baseline in force when its stint's first write was made, which is what that write was
 * computed from (rule 1). The market writer ledgers only what it intends, so unlike the base
 * price there is no `before` in the ledger to read (#1166). Baselines are append-only, so the
 * one a recapture superseded is still there: captured before that write, superseded after it.
 */
async function marketBefore(
  shopId: string,
  baselines: ReadonlyArray<{ variantGid: string; priceListGid: string }>,
  stints: ReadonlyMap<string, readonly StintRow[]>,
): Promise<Map<string, bigint>> {
  const firstAt = new Map<string, Date>();
  for (const baseline of baselines) {
    const key = recapturedKey(baseline.variantGid, baseline.priceListGid);
    const first = stints.get(key)?.at(-1);
    if (first) firstAt.set(key, first.at);
  }
  const before = new Map<string, bigint>();
  if (firstAt.size === 0) return before;

  const times = [...firstAt.values()].map((at) => at.getTime());
  const history = await inChunks(
    [...new Set(baselines.filter((b) => firstAt.has(recapturedKey(b.variantGid, b.priceListGid))).map((b) => b.variantGid))],
    (batch) =>
      prisma.baseline.findMany({
        where: {
          shopId,
          surfaceKind: "MARKET",
          variantGid: { in: batch },
          capturedAt: { lte: new Date(Math.max(...times)) },
          supersededAt: { gt: new Date(Math.min(...times)) },
        },
        select: { variantGid: true, priceListGid: true, basePrice: true, capturedAt: true, supersededAt: true },
        orderBy: { capturedAt: "desc" },
      }),
  );
  for (const row of history) {
    const key = recapturedKey(row.variantGid, row.priceListGid);
    const at = firstAt.get(key);
    if (!at || before.has(key) || row.capturedAt > at || !row.supersededAt || row.supersededAt <= at) continue;
    before.set(key, row.basePrice);
  }
  return before;
}

/**
 * Counts each campaign's baselines recaptured at its sale price again and keeps the count
 * where the campaigns list, Home and the calendar read it (#1166): this shop's campaigns whose
 * prices may be live, or the ones named.
 *
 * Called by whatever could change the answer without the campaign being planned: a
 * recapture, a baseline import, an apply that leaves it Active. Never throws: the count is
 * what the list says, and a count not taken leaves the last one, while the campaign's own
 * page, which plans, still says what is true.
 */
export async function recordRecapturedAtSale(shopId: string, campaignIds?: readonly string[]): Promise<void> {
  let ids: readonly string[];
  try {
    ids =
      campaignIds ??
      (await prisma.campaign.findMany({ where: { shopId, status: { in: [...PRICES_MAY_BE_LIVE] } }, select: { id: true } })).map(
        (campaign) => campaign.id,
      );
  } catch (error) {
    logger.warn("could not list the campaigns to count recaptured baselines for", { shopId, error: messageOf(error) });
    return;
  }
  for (const campaignId of ids) {
    const at = new Date();
    try {
      await keepRecapturedCount(shopId, campaignId, recapturedVariants(await recapturedBaselines(shopId, campaignId)), at);
    } catch (error) {
      logger.warn("could not count a campaign's baselines recaptured at its sale price", { shopId, campaignId, error: messageOf(error) });
    }
  }
}

/**
 * Keeps a campaign's count, begun at `at`, beside its stored plan (#1166), unless a count begun
 * later is already there. Through the campaign row, so a campaign deleted meanwhile, or one of
 * another shop, gets nothing. Never throws, as `recordRecapturedAtSale` does not.
 */
export async function keepRecapturedCount(shopId: string, campaignId: string, count: number, at: Date): Promise<void> {
  try {
    await prisma.$executeRaw`
      INSERT INTO "plan_summaries" ("campaignId", "shopId", "recapturedAtSale", "recapturedCountedAt")
      SELECT c."id", c."shopId", ${count}, (${at}::timestamptz AT TIME ZONE 'UTC')
      FROM "campaigns" c WHERE c."id" = ${campaignId} AND c."shopId" = ${shopId}
      ON CONFLICT ("campaignId") DO UPDATE
        SET "recapturedAtSale" = EXCLUDED."recapturedAtSale", "recapturedCountedAt" = EXCLUDED."recapturedCountedAt"
        WHERE "plan_summaries"."recapturedCountedAt" IS NULL
           OR "plan_summaries"."recapturedCountedAt" <= EXCLUDED."recapturedCountedAt"`;
  } catch (error) {
    logger.warn("could not keep a campaign's count of baselines recaptured at its sale price", { shopId, campaignId, error: messageOf(error) });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
