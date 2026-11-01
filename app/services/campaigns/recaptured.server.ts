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
  /** The current baseline's row: what a revert retires when it lets the price follow its list again (#1171). */
  baselineId: string;
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
  /** What this campaign last wrote there, in minor units: its newest write since it last reverted there (#1171). */
  latest: bigint | null;
  currency: string;
  /** A market's or wholesale price's baseline set by hand, which a revert writes back (#930). False for the base price. */
  handSet: boolean;
  /**
   * A market's or wholesale price that followed the list before this campaign -- its baseline
   * then was not set by hand -- now hand-set, because the recapture read the campaign's own
   * fixed price there as the merchant's (#1171). Reverting lets it follow the list again, rather
   * than writing the sale price back as a fixed price. False for the base price.
   */
  followedList: boolean;
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
  /**
   * `letGo`: the variants "Revert this variant" let go of as well, for that revert's own market
   * step (#1171), which runs once the variant is let go. No longer this campaign's otherwise.
   */
  options: { letGo?: boolean } = {},
): Promise<Map<string, RecapturedBaseline>> {
  const found = new Map<string, RecapturedBaseline>();
  // Since it last ended (#1166): a sale after a completed revert starts its stints afresh.
  const runs = sinceItEnded(
    await prisma.campaignRun.findMany({
      // Not a run that wrote nothing: a scoped one that stood down, or one queued and refused (#808).
      where: { shopId, campaignId, kind: { in: ["APPLY", "REASSERT", "ENROLL", "REVERT"] }, status: { not: "CANCELLED" } },
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
    id: true,
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
  const excluded = new Set(options.letGo ? [] : (campaign?.excludedVariantGids ?? []));
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
    const prior = before.get(key);
    const stint = market ? marketStint(stints.get(key)!, prior?.price ?? null) : stints.get(key)!;
    if (!recapturedAtSale(stint, { price: baseline.basePrice, capturedAt: baseline.capturedAt })) continue;
    const handSet = market && baseline.handSet === true;
    found.set(key, {
      baselineId: baseline.id,
      variantGid: baseline.variantGid,
      priceListGid: baseline.priceListGid,
      before: priceBeforeStint(stint)!,
      baseline: baseline.basePrice,
      latest: stint[0]?.intended ?? null,
      currency: baseline.currency,
      handSet,
      // Not hand-set when the sale was computed from it (#1171): the list derived that price.
      followedList: handSet && prior?.handSet === false,
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
 * With whether that one was set by hand, or followed the list (#1171).
 */
async function marketBefore(
  shopId: string,
  baselines: ReadonlyArray<{ variantGid: string; priceListGid: string }>,
  stints: ReadonlyMap<string, readonly StintRow[]>,
): Promise<Map<string, { price: bigint; handSet: boolean }>> {
  const firstAt = new Map<string, Date>();
  for (const baseline of baselines) {
    const key = recapturedKey(baseline.variantGid, baseline.priceListGid);
    const first = stints.get(key)?.at(-1);
    if (first) firstAt.set(key, first.at);
  }
  const before = new Map<string, { price: bigint; handSet: boolean }>();
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
        select: { variantGid: true, priceListGid: true, basePrice: true, handSet: true, capturedAt: true, supersededAt: true },
        orderBy: { capturedAt: "desc" },
      }),
  );
  for (const row of history) {
    const key = recapturedKey(row.variantGid, row.priceListGid);
    const at = firstAt.get(key);
    if (!at || before.has(key) || row.capturedAt > at || !row.supersededAt || row.supersededAt <= at) continue;
    // Null is a baseline from before #930 recorded it, which a revert lets follow the list.
    before.set(key, { price: row.basePrice, handSet: row.handSet === true });
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
 * Counts the live campaigns nobody has counted yet (#1171): the scheduler's, every tick, a few
 * at a time, so each campaign is counted once and then never again by this.
 *
 * The count is written by whatever could change it (`recordRecapturedAtSale`), and a campaign
 * recaptured under before that release had none. The list, Home and the calendar then said
 * "Active" until its page was opened, it was applied or imported over, or a recapture ran. A
 * campaign with no count is one with no `plan_summaries` row, or one whose row predates the
 * count. The newest first, and fifty a tick: one nobody recaptured under is a few small
 * queries, and the work a tick is for -- a sale starting on time -- has already been done.
 * Never throws. Returns how many it took up.
 */
export async function countUncounted(): Promise<number> {
  let campaigns: Array<{ id: string; shopId: string }>;
  try {
    campaigns = await prisma.campaign.findMany({
      where: {
        status: { in: [...PRICES_MAY_BE_LIVE] },
        shop: { uninstalledAt: null },
        OR: [{ planSummary: { is: null } }, { planSummary: { is: { recapturedCountedAt: null } } }],
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, shopId: true },
      take: 50,
    });
  } catch (error) {
    logger.warn("could not list the campaigns whose recaptured baselines were never counted", { error: messageOf(error) });
    return 0;
  }
  const byShop = new Map<string, string[]>();
  for (const campaign of campaigns) byShop.set(campaign.shopId, [...(byShop.get(campaign.shopId) ?? []), campaign.id]);
  for (const [shopId, ids] of byShop) await recordRecapturedAtSale(shopId, ids);
  return campaigns.length;
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
