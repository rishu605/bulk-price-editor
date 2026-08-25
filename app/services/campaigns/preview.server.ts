/**
 * Computing what a campaign would do, without writing anything.
 *
 * Preview and execution call the same planner, so a preview cannot disagree with the
 * run that follows.
 */

import { format } from "../../lib/money/format";
import type { Money } from "../../lib/money/money";
import { planRun } from "../../lib/planning/plan";
import { selectWritePath } from "../../lib/planning/write-path";
import { loadCandidates, titleMapFor } from "./candidates.server";
import { loadCampaignContext } from "./model.server";
import { guardrailsFor } from "../settings.server";
import { decideMarketPath, describePath, planMarket } from "./market-plan.server";
import { parseSurfaces } from "./market-surfaces.server";
import type { AdminClient } from "../../lib/execution/sync-executor";
import prisma from "../../db.server";
import { BLAST_RADIUS_THRESHOLD, type CampaignPreview, type MarketPreview } from "./types";

export interface PreviewOptions {
  /** Preview the revert instead of the apply. */
  revert?: boolean;
  /** Rows returned to the UI. The counts always reflect the whole plan. */
  limit?: number;
  /**
   * Needed to say how each market will be written.
   *
   * Optional because that answer requires reading the market's live settings, and a
   * caller without a client gets a preview that says the choice is made at run time
   * rather than one that guesses. Guessing is the thing to avoid: the two paths undo
   * differently, so a merchant told the wrong one is told the wrong thing about how to
   * get their prices back.
   */
  client?: AdminClient;
}

export async function previewCampaign(
  shopId: string,
  campaignId: string,
  options: PreviewOptions = {},
): Promise<CampaignPreview> {
  const { campaign, resolvable, ast } = await loadCampaignContext(shopId, campaignId);
  const [candidates, storeGuardrails] = await Promise.all([
    loadCandidates(shopId, ast),
    guardrailsFor(shopId),
  ]);

  const outcome = planRun({
    campaigns: resolvable,
    candidates,
    storeGuardrails,
    excludeCampaignId: options.revert ? campaignId : undefined,
  });

  if (outcome.kind === "blocked") {
    return {
      campaignId,
      name: campaign.name,
      status: campaign.status,
      counts: outcome.counts,
      rows: [],
      blocked: { reason: outcome.reason, variantGid: outcome.ref.variantGid },
      writePath: "none",
      writePathReason: "Blocked before planning completed.",
      markets: [],
      blastRadius: false,
    };
  }

  const limit = options.limit ?? 100;
  const shown = outcome.rows.slice(0, limit);
  const titles = await titleMapFor(shopId, shown.map((row) => row.ref.variantGid));

  const fmt = (value?: Money | null) => (value ? format(value) : null);
  const decision = selectWritePath(outcome.rows.length);
  const markets = await marketPathPreview(shopId, campaignId, resolvable, outcome, options);

  return {
    markets,
    campaignId,
    name: campaign.name,
    status: campaign.status,
    counts: outcome.counts,
    rows: shown.map((row) => ({
      variantGid: row.ref.variantGid,
      title: titles.get(row.ref.variantGid) ?? row.ref.variantGid,
      before: fmt(row.beforePrice),
      after: fmt(row.intendedPrice),
      compareAt: row.intendedCompareAtSet ? fmt(row.intendedCompareAt) : null,
      status: row.status,
      reason: row.reason,
    })),
    writePath: decision.path,
    writePathReason: decision.reason,
    blastRadius: outcome.counts.planned > BLAST_RADIUS_THRESHOLD,
  };
}


/**
 * How each targeted market will be written, in the merchant's own terms.
 *
 * Uses the same planner and the same decision function the run uses, so the review step
 * cannot describe a campaign the run will not perform. Without an admin client it says
 * so rather than guessing — the two paths are undone differently, and a merchant told
 * the wrong one is told the wrong thing about how to get their prices back.
 */
async function marketPathPreview(
  shopId: string,
  campaignId: string,
  resolvable: readonly Parameters<typeof planMarket>[3][number][],
  outcome: Extract<ReturnType<typeof planRun>, { kind: "ok" }>,
  options: PreviewOptions,
): Promise<MarketPreview[]> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { surfaces: true },
  });

  const surfaces = parseSurfaces(campaign?.surfaces);
  if (surfaces.priceLists.length === 0) return [];

  const lists = await prisma.priceListRecord.findMany({
    where: { shopId, priceListGid: { in: surfaces.priceLists } },
    select: { priceListGid: true, name: true, currency: true, adjustmentBps: true },
  });

  if (!options.client) {
    return lists.map((list) => ({
      priceListGid: list.priceListGid,
      name: list.name,
      currency: list.currency,
      path: "unknown" as const,
      explanation:
        `${list.name} will be priced when the campaign runs, and how it is written ` +
        `depends on this market's settings at that moment.`,
    }));
  }

  const variantGids = outcome.rows.map((row) => row.ref.variantGid);
  const previews: MarketPreview[] = [];

  for (const list of lists) {
    const plan = await planMarket(shopId, list, variantGids, resolvable, options.client);
    if (!plan) continue;

    const decision = await decideMarketPath(plan, options.client);

    previews.push({
      priceListGid: list.priceListGid,
      name: list.name,
      currency: list.currency,
      path: decision.path,
      explanation: describePath(decision, list.name),
    });
  }

  return previews;
}
