/**
 * The variants whose baseline was recaptured at this campaign's own sale price (#781).
 *
 * The page's status reads it, so a campaign whose baseline is its own sale price does not say
 * "every row was read back and verified"; so does the Apply confirmation, so applying it again
 * cannot discount the sale price a second time without the merchant typing the word; and so
 * does the revert report. The rule is `recapturedAtSale`, in lib/campaigns/recaptured.
 */

import prisma from "../../db.server";
import { inChunks } from "../../lib/db/chunk";
import { LANDED } from "../../lib/execution/landed";
import { priceBeforeStint, recapturedAtSale, stintOf, type StintRow } from "../../lib/campaigns/recaptured";

export interface RecapturedBaseline {
  /** The price the ledger recorded before this campaign wrote the variant, in minor units. */
  before: bigint;
  /** The baseline now, a price this campaign wrote, in minor units. */
  baseline: bigint;
  currency: string;
}

/**
 * The base-price variants this campaign is pricing whose current baseline is a sale price it
 * wrote, recaptured while it was live, by variant id. Of `variantGids` only, when given.
 *
 * Its applies, re-assertions and enrolments are its writes; a revert ends them. Only the
 * baselines captured since the oldest of its newest twenty runs are read, and the ledger only
 * for those, so a campaign nobody recaptured under costs a few small queries, and a draft one.
 */
export async function recapturedBaselines(
  shopId: string,
  campaignId: string,
  variantGids?: readonly string[],
): Promise<Map<string, RecapturedBaseline>> {
  const found = new Map<string, RecapturedBaseline>();
  const runs = await prisma.campaignRun.findMany({
    where: { shopId, campaignId, kind: { in: ["APPLY", "REASSERT", "ENROLL", "REVERT"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, createdAt: true },
    take: 20,
  });
  const oldestWrite = runs.filter((run) => run.kind !== "REVERT").at(-1);
  if (!oldestWrite || variantGids?.length === 0) return found;

  const recent = {
    shopId,
    surfaceKind: "BASE" as const,
    priceListGid: "",
    supersededAt: null,
    capturedAt: { gt: oldestWrite.createdAt },
  };
  const select = { variantGid: true, basePrice: true, currency: true, capturedAt: true } as const;
  const [campaign, baselines] = await Promise.all([
    prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { excludedVariantGids: true } }),
    variantGids
      ? inChunks([...variantGids], (batch) => prisma.baseline.findMany({ where: { ...recent, variantGid: { in: batch } }, select }))
      : prisma.baseline.findMany({ where: recent, select }),
  ]);
  // Let go of by "Revert this variant": no longer this campaign's (#886).
  const excluded = new Set(campaign?.excludedVariantGids ?? []);
  const candidates = baselines.filter((baseline) => !excluded.has(baseline.variantGid));
  if (candidates.length === 0) return found;

  const reverts = new Set(runs.filter((run) => run.kind === "REVERT").map((run) => run.id));
  const changes = await inChunks(
    candidates.map((baseline) => baseline.variantGid),
    (batch) =>
      prisma.variantChange.findMany({
        where: {
          runId: { in: runs.map((r) => r.id) },
          status: { in: [...LANDED, "APPLIED"] },
          surfaceKind: "BASE",
          priceListGid: "",
          variantGid: { in: batch },
        },
        // Newest first, as `stintOf` reads them: a revert's row ends the writes before it.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { variantGid: true, runId: true, beforePrice: true, intendedPrice: true, createdAt: true },
      }),
  );

  const rows = new Map<string, StintRow[]>();
  for (const change of changes) {
    const row = { revert: reverts.has(change.runId), before: change.beforePrice, intended: change.intendedPrice, at: change.createdAt };
    const list = rows.get(change.variantGid);
    if (list) list.push(row);
    else rows.set(change.variantGid, [row]);
  }

  for (const baseline of candidates) {
    const stint = stintOf(rows.get(baseline.variantGid) ?? []);
    if (!recapturedAtSale(stint, { price: baseline.basePrice, capturedAt: baseline.capturedAt })) continue;
    found.set(baseline.variantGid, { before: priceBeforeStint(stint)!, baseline: baseline.basePrice, currency: baseline.currency });
  }
  return found;
}
