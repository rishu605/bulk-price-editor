/**
 * Computing what a campaign would do, without writing anything.
 *
 * Preview and execution call the same planner, so a preview cannot disagree with the
 * run that follows.
 */

import { format } from "../../lib/money/format";
import { money, type Money } from "../../lib/money/money";
import { planRun } from "../../lib/planning/plan";
import { selectWritePath } from "../../lib/planning/write-path";
import { loadCandidates, titleMapFor } from "./candidates.server";
import { loadCampaignContext } from "./model.server";
import { guardrailsFor, readSettings } from "../settings.server";
import { describeImpact, marginImpact } from "../../lib/pricing/margin";
import { decideMarketPath, describePath, planMarket } from "./market-plan.server";
import { parseSurfaces } from "./market-surfaces.server";
import type { AdminClient } from "../../lib/execution/sync-executor";
import prisma from "../../db.server";
import {
  BLAST_RADIUS_THRESHOLD,
  type CampaignPreview,
  type MarketPreview,
  type SurfaceCell,
} from "./types";
import { rowsThatFit } from "../../lib/ui/table-budget";

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
      margin: null,
      blastRadius: false,
    };
  }

  // Rows are limited by what the table can render, which depends on how many markets
  // this campaign targets: each one is another column, and the widget blanks the whole
  // page rather than the table when given too many cells.
  const surfaceCount = await targetedMarketCount(shopId, campaignId);
  const limit = options.limit ?? rowsThatFit(BASE_PREVIEW_COLUMNS + surfaceCount);
  const shown = outcome.rows.slice(0, limit);
  const titles = await titleMapFor(shopId, shown.map((row) => row.ref.variantGid));

  const fmt = (value?: Money | null) => (value ? format(value) : null);
  // Costs for every variant in the plan, not just the shown page. Read from the current
  // baseline because that is what the guardrails use, so the margin shown here and the
  // floor that clamps a price cannot disagree.
  const costs = await costsFor(
    shopId,
    outcome.rows.map((row) => row.ref.variantGid),
  );

  const marketCells = await marketCellsFor(
    shopId,
    campaignId,
    resolvable,
    shown.map((row) => row.ref.variantGid),
    options,
  );
  const decision = selectWritePath(outcome.rows.length);
  const markets = await marketPathPreview(shopId, campaignId, resolvable, outcome, options);

  // What this does to margin, before it happens. Computed over the whole plan rather
  // than the shown page: a merchant asking "what does this cost me" means the campaign,
  // not the first twenty-five rows of it.
  const storeSettings = await readSettings(shopId);
  const margin = marginImpact(
    outcome.rows
      .filter((row) => row.status !== "skipped" && row.intendedPrice && row.beforePrice)
      .map((row) => ({
        variantGid: row.ref.variantGid,
        title: titles.get(row.ref.variantGid) ?? row.ref.variantGid,
        cost: costs.get(row.ref.variantGid),
        before: row.beforePrice!,
        after: row.intendedPrice!,
      })),
    storeSettings.minMarginPercent,
  );

  return {
    markets,
    margin: {
      ...margin,
      // Named products, capped. Twenty is enough to see the shape of the problem; the
      // export has all of them.
      belowTarget: margin.belowTarget.slice(0, 20),
      belowCost: margin.belowCost.slice(0, 20),
      summary: describeImpact(margin, storeSettings.minMarginPercent),
    },
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
      ...(marketCells.size > 0
        ? { surfaces: marketCells.get(row.ref.variantGid) ?? {} }
        : {}),
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
      clamped: 0,
      skipped: 0,
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
    const counts = plan.outcome.kind === "ok" ? plan.outcome.counts : { clamped: 0, skipped: 0 };

    previews.push({
      priceListGid: list.priceListGid,
      name: list.name,
      currency: list.currency,
      path: decision.path,
      explanation: describePath(decision, list.name),
      clamped: counts.clamped,
      skipped: counts.skipped,
    });
  }

  return previews;
}


/** Columns a base-only preview renders: variant, before, after, compare-at, state. */
const BASE_PREVIEW_COLUMNS = 5;

/** How many markets this campaign also prices, for sizing the table. */
async function targetedMarketCount(shopId: string, campaignId: string): Promise<number> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { surfaces: true },
  });

  return parseSurfaces(campaign?.surfaces).priceLists.length;
}

/**
 * Each variant's outcome on each market, for the side-by-side matrix.
 *
 * Planned through `planMarket`, which is the same function the run uses — so the
 * matrix shows the prices that will actually be written rather than a second
 * calculation that might not agree with the first.
 */
async function marketCellsFor(
  shopId: string,
  campaignId: string,
  resolvable: readonly Parameters<typeof planMarket>[3][number][],
  variantGids: readonly string[],
  options: PreviewOptions,
): Promise<Map<string, Record<string, SurfaceCell>>> {
  const cells = new Map<string, Record<string, SurfaceCell>>();
  if (!options.client || variantGids.length === 0) return cells;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { surfaces: true },
  });

  const surfaces = parseSurfaces(campaign?.surfaces);
  if (surfaces.priceLists.length === 0) return cells;

  const lists = await prisma.priceListRecord.findMany({
    where: { shopId, priceListGid: { in: surfaces.priceLists } },
    select: { priceListGid: true, name: true, currency: true, adjustmentBps: true },
  });

  for (const list of lists) {
    const plan = await planMarket(shopId, list, variantGids, resolvable, options.client);
    if (!plan || plan.outcome.kind !== "ok") continue;

    for (const row of plan.outcome.rows) {
      const forVariant = cells.get(row.ref.variantGid) ?? {};
      forVariant[list.priceListGid] = {
        after: row.intendedPrice ? format(row.intendedPrice) : null,
        compareAt: row.intendedCompareAtSet && row.intendedCompareAt
          ? format(row.intendedCompareAt)
          : null,
        status: row.status,
        reason: row.reason,
      };
      cells.set(row.ref.variantGid, forVariant);
    }
  }

  return cells;
}


/**
 * Each variant's cost, from the current baseline.
 *
 * From the baseline rather than the catalogue mirror, because the baseline is what the
 * margin guardrail reads at resolve time. Taking them from different places would let the
 * margin a merchant is shown disagree with the floor that clamps the price.
 */
async function costsFor(shopId: string, variantGids: readonly string[]) {
  if (variantGids.length === 0) return new Map<string, Money>();

  const rows = await prisma.baseline.findMany({
    where: {
      shopId,
      surfaceKind: "BASE",
      priceListGid: "",
      supersededAt: null,
      variantGid: { in: [...variantGids] },
      cost: { not: null },
    },
    select: { variantGid: true, cost: true, currency: true },
  });

  return new Map(
    rows.map((row) => [row.variantGid, money(Number(row.cost), row.currency)] as const),
  );
}
