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
import { loadCandidates, titleMapFor, withWritten } from "./candidates.server";
import { revertTakesBack } from "./handover.server";
import { loadCampaignContext, importIdsOf} from "./model.server";
import { guardrailsFor, readSettings } from "../settings.server";
import { uncontrolledAmong } from "../reconciliation.server";
import { offBaseline } from "./off-baseline";
import { describeImpact, marginImpact } from "../../lib/pricing/margin";
import {
  decideMarketPath,
  describePath,
  planMarket,
  recordedMarketWrites,
  UnconvertedMarketError,
} from "./market-plan.server";
import type { ResolvableCampaign } from "../../lib/pricing/types";
import { describeLadderUnread, describeMarketSkips, describeMovedMarket, describeStaleSettingMarket } from "../../lib/markets/guardrails";
import { parseSurfaces } from "./market-surfaces.server";
import { labelled } from "../../lib/markets/display-name";
import type { AdminClient } from "../../lib/execution/sync-executor";
import prisma from "../../db.server";
import {
  type CampaignPreview,
  type MarketPreview,
  type PreviewRow,
  type SurfaceCell,
} from "./types";
import { rowsThatFit } from "../../lib/ui/table-budget";
import { inChunks } from "../../lib/db/chunk";
import { hasOwnFloors } from "../../lib/campaigns/campaign-floors";
import { describeBlocked } from "./blocked.server";
import { recapturedBaselines, type RecapturedBaseline } from "./recaptured.server";
import { recapturedVariants } from "../../lib/campaigns/recaptured";

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

  return planlessPreview(campaignId, campaign, { writing: writingText(campaign.status) });
}

/** Why the page shows no preview while a run writes the campaign (#803). */
export function writingText(status: string): string {
  return (
    `This campaign is being ${status === "REVERTING" ? "reverted" : "applied"} right now, so there is no ` +
    "preview to show: what it changes is already decided. The Runs tab follows the run, and the preview comes back " +
    "when it finishes."
  );
}

/**
 * A preview with no plan in it, saying why: a run is writing the campaign (#803), or its
 * first plan is still being worked out in the background (#812). Nothing in it is a number
 * a merchant could act on -- every count zero, no rows, no confirmation -- and the page reads
 * `writing` or `planning` and says that instead of rendering them. `refused` still comes from
 * the stored rule, which needs no plan, so a campaign the run would refuse says so meanwhile.
 */
export function planlessPreview(
  campaignId: string,
  campaign: { name: string; status: string; ruleRows?: unknown },
  why: { writing: string } | { planning: string },
): CampaignPreview {
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
    ...("planning" in why && campaign.ruleRows !== undefined ? refusedRule(campaign.ruleRows) : {}),
    ...why,
  };
}

export async function previewCampaign(
  shopId: string,
  campaignId: string,
  options: PreviewOptions = {},
): Promise<CampaignPreview> {
  const { campaign, resolvable, heldEdits, others, ast, breach } = await loadCampaignContext(shopId, campaignId);
  const [scoped, storeGuardrails, written] = await Promise.all([
    loadCandidates(shopId, ast, undefined, importIdsOf(resolvable)),
    guardrailsFor(shopId),
    options.revert ? revertTakesBack(shopId, campaignId) : Promise.resolve([]),
  ]);
  // A revert takes back what it wrote, in scope or not, and so does its preview: a product
  // archived mid-sale is out of scope and still comes back to its baseline (#751, #828).
  // What another campaign's revert handed it too, by the same answer the revert uses (#998).
  const candidates = await withWritten(shopId, scoped, written, importIdsOf(resolvable));

  const outcome = planRun({
    campaigns: resolvable,
    candidates,
    storeGuardrails,
    // As the run names it, so a campaign that prices only its markets previews no base price (#1094).
    campaignId,
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
      blocked: {
        reason: outcome.reason,
        variantGid: outcome.ref.variantGid,
        // What to do, as the run says it (#1161). No policy for a revert's: the campaign is out of
        // its own plan, so what stops it is another campaign's policy, which names that one (#1169).
        message: await describeBlocked(shopId, outcome.blocked, "preview", {
          campaignId,
          breach: options.revert ? undefined : breach,
          ownFloors: !options.revert && hasOwnFloors(campaign.guardrails),
        }),
      },
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
  // A campaign that prices only its markets plans no base row, and the rows are where the
  // market prices hang: its preview listed nothing at all, so the euro prices it would write
  // had nowhere to appear (#1111). Its rows are the variants its markets are priced over,
  // with the base price as it is. Not on a revert, which keeps the rows it plans.
  const marketsOnlyScope = resolvable.some((entry) => entry.id === campaignId && entry.marketsOnly) && !options.revert
    ? marketScope(campaignId, outcome.rows, outcome.unchanged)
    : null;
  const shownGids = marketsOnlyScope ? marketsOnlyScope.slice(0, limit) : shown.map((row) => row.ref.variantGid);
  const titles = await titleMapFor(shopId, shownGids);

  const fmt = (value?: Money | null) => (value ? format(value) : null);
  // Costs for every variant in the plan, not just the shown page. Read from the current
  // baseline because that is what the guardrails use, so the margin shown here and the
  // floor that clamps a price cannot disagree.
  const costs = await costsFor(
    shopId,
    outcome.rows.map((row) => row.ref.variantGid),
  );

  const marketCells = await marketCellsFor(shopId, campaignId, resolvable, shownGids, options);
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
  // Its variants whose baseline is its own sale price, recaptured while it was live (#781):
  // the status says so, and applying them again asks for the word. Not on a revert's preview.
  const recaptured = options.revert ? new Map<string, RecapturedBaseline>() : await recapturedBaselines(shopId, campaignId);
  // Whether applying this needs the word typed, and why (#818): the dialog says these
  // reasons and `blastRadiusRefusal` re-checks them from a fresh preview. Its market prices'
  // depth with them (#1171), after `marketPathPreview` above has recorded their baselines; not
  // on a revert's preview, whose plan leaves this campaign out.
  const confirm = await blastRadiusOf(
    shopId,
    outcome.rows,
    outcome.counts,
    candidates,
    confirmThresholdsOf(storeSettings),
    titles,
    { campaignId, recaptured, unchanged: outcome.unchanged, ...(options.revert ? {} : { campaigns: resolvable }) },
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
    rows: marketsOnlyScope
      ? marketsOnlyRows(shownGids, candidates, campaignId, titles, marketCells)
      : shown.map((row) => ({
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
    ...(marketsOnlyScope ? { marketsOnlyVariants: marketsOnlyScope.length } : {}),
    writePath: decision.path,
    writePathReason: decision.reason,
    tagKit: campaign.tagKit,
    blastRadius: asksForConfirmation(confirm),
    confirm,
    // A stored rule the run refuses (#818), said here so the page offers no Apply the run
    // would turn down. Not on a revert: taking such a campaign back is always allowed.
    ...(options.revert ? {} : refusedRule(campaign.ruleRows)),
    staleBaselines,
    // Variants, a market's or wholesale price among them (#1166), and how many of the prices are those.
    recapturedAtSale: recapturedVariants(recaptured),
    recapturedInMarkets: [...recaptured.values()].filter((entry) => entry.priceListGid !== "").length,
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


/** Said on each row of a campaign that prices only its markets: why its base price stays. */
export const MARKETS_ONLY_ROW_REASON = "Base price unchanged: this campaign prices its markets only";

/**
 * The rows of a campaign that prices only its markets (#1111): each variant its markets are
 * priced over, at the base price it has now, before and after, with what each market gets.
 */
function marketsOnlyRows(
  variantGids: readonly string[],
  candidates: readonly PlanCandidate[],
  campaignId: string,
  titles: ReadonlyMap<string, string>,
  marketCells: ReadonlyMap<string, Record<string, SurfaceCell>>,
): PreviewRow[] {
  const base = new Map(
    candidates.filter((candidate) => candidate.ref.priceListGid === "").map((candidate) => [candidate.ref.variantGid, candidate.livePrice]),
  );
  return variantGids.map((variantGid) => {
    const live = base.get(variantGid);
    const price = live ? format(live) : null;
    return {
      variantGid,
      title: titles.get(variantGid) ?? variantGid,
      before: price,
      after: price,
      compareAt: null,
      status: "pending",
      reason: MARKETS_ONLY_ROW_REASON,
      campaignId,
      surfaces: marketCells.get(variantGid) ?? {},
    };
  });
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
 *
 * `own` is the campaign whose apply this is, so a write that would discount its own sale price
 * again is counted (#781), and its baselines recaptured at that price when the caller already
 * has them; otherwise they are read for the rows written. With the plan's `unchanged`, so a
 * market or wholesale price is counted too (#1166): the apply prices the markets of every
 * variant the campaign wins, already at its base price or not (`marketScope`). And with the
 * campaigns the apply plans with, so a market or wholesale price moving past the change
 * threshold counts as a base price does (#1171), planned from its recorded baseline
 * (`recordedMarketWrites`). Its depth only: how many prices a campaign writes is still its base
 * prices, so a sale over two markets does not start asking at a third of the variants it did.
 */
export async function blastRadiusOf(
  shopId: string,
  rows: readonly PlannedRow[],
  counts: { planned: number; clampedToMinimum: number },
  candidates: readonly PlanCandidate[],
  thresholds: ConfirmThresholds,
  titles: Map<string, string>,
  own: {
    campaignId: string;
    recaptured?: ReadonlyMap<string, RecapturedBaseline>;
    unchanged?: readonly { ref: { variantGid: string }; campaignId?: string }[];
    /** The campaigns the apply plans with, its own among them: its market prices are planned with them (#1171). */
    campaigns?: readonly ResolvableCampaign[];
  },
): Promise<BlastRadius> {
  const baselines = new Map(candidates.map((candidate) => [refKey(candidate.ref), candidate.baseline]));
  const written: WrittenPrice[] = [];
  // The ones this campaign's own price is written to: only those can discount its sale price again.
  const mine: string[] = [];
  for (const row of rows) {
    if (row.status === "skipped" || !row.intendedPrice || row.ref.priceListGid !== "") continue;
    const baseline = baselines.get(refKey(row.ref));
    if (!baseline) continue;
    written.push({ variantGid: row.ref.variantGid, baseline: baseline.price, after: row.intendedPrice, cost: baseline.cost });
    if (row.campaignId === own.campaignId) mine.push(row.ref.variantGid);
  }

  // The variants whose markets this apply prices (`marketScope`), and its prices there (#1171).
  const priced = marketScope(own.campaignId, rows, own.unchanged ?? []);
  const markets = own.campaigns ? await recordedMarketWrites(shopId, own.campaignId, own.campaigns, priced) : [];
  const large = largeChanges([...written, ...markets], thresholds.changePercent);
  const marketLarge = largeChanges(markets, thresholds.changePercent).count;
  const top = large.largest;
  // Titled from the page of rows when it is on it, and looked up alone when it is not.
  const titleOf = async (gid: string) => titles.get(gid) ?? (await titleMapFor(shopId, [gid])).get(gid) ?? gid;
  const title = top ? await titleOf(top.variantGid) : null;

  // Its own writes over a baseline recaptured at its sale price, which compound (#781). And
  // its market prices over one (#1166), on the lists it still prices, for the variants whose
  // markets this apply prices: those compound as surely, and nothing else asked about them.
  // Read whole rather than for these variants: only what was captured since the campaign
  // first wrote is read either way, and a scope of 102,132 is twenty-one chunks of nothing.
  const recaptured: ReadonlyMap<string, RecapturedBaseline> =
    own.recaptured ?? (priced.length > 0 ? await recapturedBaselines(shopId, own.campaignId) : new Map());
  const marketsPriced = new Set(priced);
  const compounded = [
    ...mine.filter((gid) => recaptured.has(gid)),
    ...[...recaptured.values()]
      .filter((entry) => entry.priceListGid !== "" && entry.targeted && marketsPriced.has(entry.variantGid))
      .map((entry) => entry.variantGid),
  ];

  return {
    thresholds,
    planned: counts.planned,
    largeChanges: large.count,
    largest: top
      ? {
          title: title ?? top.variantGid,
          ...(top.market ? { market: top.market } : {}),
          before: formatPrice(top.baseline.amount, top.baseline.currency),
          after: formatPrice(top.after.amount, top.after.currency),
          basisPoints: top.basisPoints,
          direction: top.after.amount < top.baseline.amount ? "down" : "up",
        }
      : null,
    // Counted wherever the market prices were (#1171), none included, so a confirmation knows.
    ...(own.campaigns ? { marketLargeChanges: marketLarge } : {}),
    atMinimum: counts.clampedToMinimum,
    ...(compounded.length > 0
      ? { compounding: { count: compounded.length, title: await titleOf(compounded[0]!) } }
      : {}),
  };
}

/** `refused` for a campaign whose stored rule cannot be applied, or nothing. */
export function refusedRule(ruleRows: unknown): { refused?: string } {
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
      // The campaign's surfaces, as the run hands them over: a campaign that also moves the
      // base price is never offered the market-wide change, here or there (#1109).
      decision = await decideMarketPath(plan, options.client, surfaces);
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
      ...describeMovedMarket(list.name, plan.moved.length, plan.movedBy),
      ...describeStaleSettingMarket(list.name, plan.stale.length),
      ...describeLadderUnread(list.name, plan.ladderUnread),
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
