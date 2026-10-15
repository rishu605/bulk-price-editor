/**
 * Computing what a campaign would do, without writing anything.
 *
 * Preview and execution call the same planner, so a preview cannot disagree with the
 * run that follows.
 */

import { alreadyCorrectBy, outrankedBy, overlapsFrom } from "../../lib/planning/overlaps";
import { format, formatPrice } from "../../lib/money/format";
import { marketScope } from "../../lib/planning/market-scope";
import { money, type Money } from "../../lib/money/money";
import { planRun, refKey } from "../../lib/planning/plan";
import type { PlanCandidate, PlannedRow } from "../../lib/planning/types";
import {
  asksForConfirmation,
  confirmThresholdsOf,
  largeChanges,
  type BlastRadius,
  type ConfirmThresholds,
  type WrittenPrice,
} from "../../lib/campaigns/blast-radius";
import { unappliableRule } from "../../lib/campaigns/rule-limits";
import { selectWritePath } from "../../lib/planning/write-path";
import { loadCandidates, pricesWrittenBy, titleMapFor, withWritten } from "./candidates.server";
import { loadCampaignContext, importIdsOf} from "./model.server";
import { guardrailsFor, readSettings } from "../settings.server";
import { uncontrolledAmong } from "../reconciliation.server";
import { offBaseline } from "./off-baseline";
import { describeImpact, marginImpact } from "../../lib/pricing/margin";
import {
  decideMarketPath,
  describePath,
  planMarket,
  UnconvertedMarketError,
} from "./market-plan.server";
import { describeMarketSkips, describeMovedMarket } from "../../lib/markets/guardrails";
import { parseSurfaces } from "./market-surfaces.server";
import { labelled } from "../../lib/markets/display-name";
import type { AdminClient } from "../../lib/execution/sync-executor";
import prisma from "../../db.server";
import {
  type CampaignPreview,
  type MarketPreview,
  type SurfaceCell,
} from "./types";
import { rowsThatFit } from "../../lib/ui/table-budget";
import { inChunks } from "../../lib/db/chunk";

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

/**
 * The campaign page's preview: the plan, unless a run is writing this campaign (#803).
 *
 * A plan loads every candidate and baseline in scope. The page used to make one on every
 * load and every tab switch, including while the campaign's own run was writing the same
 * tables -- on a 102,132-variant apply, a merchant watching the run page held connections
 * the run needed, the 10-connection pool ran dry, every shop's pages went blank and the run
 * died of a pool timeout (#802). While a run writes, what it will change is already decided,
 * and the run's own progress is the thing worth showing.
 */
export async function pagePreview(
  shopId: string,
  campaignId: string,
  options: PreviewOptions = {},
): Promise<CampaignPreview> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { name: true, status: true },
  });
  if (campaign.status !== "APPLYING" && campaign.status !== "REVERTING") return previewCampaign(shopId, campaignId, options);

  return {
    campaignId,
    name: campaign.name,
    status: campaign.status,
    counts: { planned: 0, noop: 0, skipped: 0, clamped: 0, clampedToMinimum: 0 },
    rows: [],
    writePath: "",
    writePathReason: "",
    markets: [],
    margin: null,
    blastRadius: false,
    staleBaselines: 0,
    writing:
      `This campaign is being ${campaign.status === "REVERTING" ? "reverted" : "applied"} right now, so there is no ` +
      "preview to show: what it changes is already decided. The Runs tab follows the run, and the preview comes back " +
      "when it finishes.",
  };
}

export async function previewCampaign(
  shopId: string,
  campaignId: string,
  options: PreviewOptions = {},
): Promise<CampaignPreview> {
  const { campaign, resolvable, heldEdits, others, ast } = await loadCampaignContext(shopId, campaignId);
  const [scoped, storeGuardrails, written] = await Promise.all([
    loadCandidates(shopId, ast, undefined, importIdsOf(resolvable)),
    guardrailsFor(shopId),
    options.revert ? pricesWrittenBy(shopId, campaignId) : Promise.resolve([]),
  ]);
  // A revert takes back what it wrote, in scope or not, and so does its preview: a product
  // archived mid-sale is out of scope and still comes back to its baseline (#751, #828).
  const candidates = await withWritten(shopId, scoped, written, importIdsOf(resolvable));

  const outcome = planRun({
    campaigns: resolvable,
    candidates,
    storeGuardrails,
    excludeCampaignId: options.revert ? campaignId : undefined,
    heldEdits,
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
      staleBaselines: 0,
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
  // Over the same variants the run prices markets for: the already-correct ones the rows
  // leave out included (#841).
  // A revert preview keeps the rows it plans: a revert does not price markets from a scope.
  const markets = await marketPathPreview(
    shopId,
    campaignId,
    resolvable,
    options.revert ? outcome.rows.map((row) => row.ref.variantGid) : marketScope(campaignId, outcome.rows, outcome.unchanged),
    options,
  );

  // What this does to margin, before it happens. Computed over the whole plan rather
  // than the shown page: a merchant asking "what does this cost me" means the campaign,
  // not the first twenty-five rows of it.
  const storeSettings = await readSettings(shopId);

  // The prices this campaign would write, from a baseline nobody updated after the
  // merchant changed the price outside the app (#745): said before Apply, because those
  // rows are discounted from -- and reverted to -- the old price.
  const staleBaselines = await uncontrolledAmong(
    shopId,
    offBaseline(
      outcome.rows.filter((row) => row.status !== "skipped" && row.campaignId === campaignId),
      candidates,
    ),
  );
  // Whether applying this needs the word typed, and why (#818): the dialog says these
  // reasons and `blastRadiusRefusal` re-checks them from a fresh preview.
  const confirm = await blastRadiusOf(
    shopId,
    outcome.rows,
    outcome.counts,
    candidates,
    confirmThresholdsOf(storeSettings),
    titles,
  );

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
      campaignId: row.campaignId,
      ...(marketCells.size > 0
        ? { surfaces: marketCells.get(row.ref.variantGid) ?? {} }
        : {}),
    })),
    writePath: decision.path,
    writePathReason: decision.reason,
    blastRadius: asksForConfirmation(confirm),
    confirm,
    // A stored rule the run refuses (#818), said here so the page offers no Apply the run
    // would turn down. Not on a revert: taking such a campaign back is always allowed.
    ...(options.revert ? {} : refusedRule(campaign.ruleRows)),
    staleBaselines,
    // From the planner's coverage, every candidate included: a variant another campaign
    // keeps is usually already at its price, and the rows leave those out (#821).
    overlaps: overlapsFrom(outcome.coverage, campaignId, others),
    // From the same plan, by the resolver's winner (#837): which of the already-correct
    // variants are this campaign's and which another campaign is pricing, and whether it
    // prices any of its variants at all.
    alreadyCorrect: alreadyCorrectBy(outcome.unchanged, campaignId, others),
    outrankedBy: outrankedBy(outcome.coverage, campaignId, others),
  };
}


/**
 * What the typed confirmation reads from a plan (#818): how many prices it writes, which
 * of them move further than the change threshold, and how many were taken to zero.
 *
 * Over the base prices the plan writes, against each one's baseline and cost -- the values
 * the resolver priced from, so the depth a merchant is warned about is the depth written.
 *
 * The one reading of a plan's reach: the Apply dialog's, and the start check's at save and at
 * start (#1009), which reads the run's own plan.
 */
export async function blastRadiusOf(
  shopId: string,
  rows: readonly PlannedRow[],
  counts: { planned: number; clampedToMinimum: number },
  candidates: readonly PlanCandidate[],
  thresholds: ConfirmThresholds,
  titles: Map<string, string>,
): Promise<BlastRadius> {
  const baselines = new Map(candidates.map((candidate) => [refKey(candidate.ref), candidate.baseline]));
  const written: WrittenPrice[] = [];
  for (const row of rows) {
    if (row.status === "skipped" || !row.intendedPrice || row.ref.priceListGid !== "") continue;
    const baseline = baselines.get(refKey(row.ref));
    if (!baseline) continue;
    written.push({ variantGid: row.ref.variantGid, baseline: baseline.price, after: row.intendedPrice, cost: baseline.cost });
  }

  const large = largeChanges(written, thresholds.changePercent);
  const top = large.largest;
  // Titled from the page of rows when it is on it, and looked up alone when it is not.
  const title = top ? (titles.get(top.variantGid) ?? (await titleMapFor(shopId, [top.variantGid])).get(top.variantGid)) : null;

  return {
    thresholds,
    planned: counts.planned,
    largeChanges: large.count,
    largest: top
      ? {
          title: title ?? top.variantGid,
          before: formatPrice(top.baseline.amount, top.baseline.currency),
          after: formatPrice(top.after.amount, top.after.currency),
          basisPoints: top.basisPoints,
          direction: top.after.amount < top.baseline.amount ? "down" : "up",
        }
      : null,
    atMinimum: counts.clampedToMinimum,
  };
}

/** `refused` for a campaign whose stored rule cannot be applied, or nothing. */
function refusedRule(ruleRows: unknown): { refused?: string } {
  const refused = unappliableRule(ruleRows);
  return refused ? { refused } : {};
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
  /** Every variant the markets are planned over, as the run plans them (`marketScope`). */
  variantGids: readonly string[],
  options: PreviewOptions,
): Promise<MarketPreview[]> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { surfaces: true },
  });

  const surfaces = parseSurfaces(campaign?.surfaces);
  if (surfaces.priceLists.length === 0) return [];

  const lists = await namedLists(shopId, surfaces.priceLists);

  if (!options.client) {
    return lists.map((list) => ({
      priceListGid: list.priceListGid,
      name: list.name,
      currency: list.currency,
      path: "unknown" as const,
      clamped: 0,
      skipped: 0,
      refused: false,
      explanation:
        `${list.name} will be priced when the campaign runs, and how it is written ` +
        `depends on this market's settings at that moment.`,
    }));
  }

  const previews: MarketPreview[] = [];

  for (const list of lists) {
    // A market that answers in the wrong currency is refused, not priced, and the run
    // refuses only that market (`market-surfaces.server.ts`). Catching it here is what
    // makes the preview say the same thing: before #645 it escaped instead, and one
    // misconfigured market returned the generic error screen for the whole campaign, so
    // the page could not be opened at all.
    let plan;
    let decision;
    try {
      plan = await planMarket(shopId, list, variantGids, resolvable, options.client);
      if (!plan) continue;
      decision = await decideMarketPath(plan, options.client);
    } catch (error) {
      if (!(error instanceof UnconvertedMarketError)) throw error;

      // The error's own sentence, because it already names the market, the currency that
      // arrived and the next action. Rewriting it here would be a second place for that
      // wording to drift from the one the run reports.
      previews.push({
        priceListGid: list.priceListGid,
        name: list.name,
        currency: list.currency,
        path: "unknown",
        explanation: error.message,
        clamped: 0,
        skipped: 0,
        refused: true,
      });
      continue;
    }

    const counts = plan.outcome.kind === "ok" ? plan.outcome.counts : { clamped: 0, skipped: 0 };
    // The run's own sentences for what this market leaves at full price, so the review
    // step names the reason the run will report rather than only a count (#691).
    const skipNotes = [
      ...(plan.outcome.kind === "ok"
        ? describeMarketSkips(list.name, list.currency, plan.outcome.rows, plan.inStoreCurrency)
        : []),
      ...describeMovedMarket(list.name, plan.moved.length),
    ];

    // Nothing to write (#844): no write path to describe -- "will get a price per product"
    // over a market getting no price at all -- only that it is left as it is, and why.
    const writes = plan.outcome.kind === "ok" ? plan.outcome.counts.planned : 0;
    const path = writes > 0 ? describePath(decision, list.name) : `${list.name} will be left at its normal prices.`;

    previews.push({
      priceListGid: list.priceListGid,
      name: list.name,
      currency: list.currency,
      path: decision.path,
      explanation: [path, ...skipNotes].join(" "),
      clamped: counts.clamped,
      skipped: counts.skipped,
      refused: false,
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

  const lists = await namedLists(shopId, surfaces.priceLists);

  for (const list of lists) {
    // Refused the same way, and for the same reason, as in `marketPathPreview` above.
    // A refused market gets no column of its own: the Markets card says why it is
    // missing, and a column of blanks beside priced ones would read as "no change here"
    // rather than "not priced at all".
    let plan;
    try {
      plan = await planMarket(shopId, list, variantGids, resolvable, options.client);
    } catch (error) {
      if (!(error instanceof UnconvertedMarketError)) throw error;
      continue;
    }

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

  // Chunked, and this one cannot be left to Prisma at all. A long `IN` list is
  // normally split by the query engine -- badly, which is #324 -- but `cost: { not:
  // null }` is a negation, and Prisma refuses to split a query that has one. The whole
  // statement fails with P2029 rather than degrading, so the campaign page returned a
  // generic error screen for every campaign over ~32,765 variants (#346).
  const rows = await inChunks([...variantGids], (batch) =>
    prisma.baseline.findMany({
      where: {
        shopId,
        surfaceKind: "BASE",
        priceListGid: "",
        supersededAt: null,
        variantGid: { in: batch },
        cost: { not: null },
      },
      select: { variantGid: true, cost: true, currency: true },
    }),
  );

  return new Map(
    rows.map((row) => [row.variantGid, money(Number(row.cost), row.currency)] as const),
  );
}

/**
 * The campaign's price lists, each under the name the editor gave it (#778).
 *
 * Shopify names a market's list after its handle -- `pricing_by_market.19853246698_…` --
 * and the preview printed that in its column headers, the Markets card, the Apply dialog
 * and the CSV, where the editor had said "United States". Named once here, so every
 * sentence built from a list below uses the same words.
 */
async function namedLists(shopId: string, priceListGids: readonly string[]) {
  return (await prisma.priceListRecord.findMany({
    where: { shopId, priceListGid: { in: [...priceListGids] } },
    // Everything `planMarket` reads, the country included: without it a percentage market
    // is read in the shop's currency and refused, though the run prices it (#840).
    select: {
      priceListGid: true,
      name: true,
      currency: true,
      adjustmentBps: true,
      contextCountry: true,
      catalogTitle: true,
      surfaceKind: true,
    },
  })).map(labelled);
}
