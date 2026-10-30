/**
 * Shared types for the campaign services.
 *
 * Kept separate from the modules that use them so create/preview/run/history can
 * each stay focused without importing one another just for a type.
 */

import type { AlreadyCorrect, Overlap } from "../../lib/planning/overlaps";
import type { AdjustmentRule, CompareAtPolicy, Guardrails } from "../../lib/pricing/types";
import type { PlannedRow } from "../../lib/planning/types";
import type { MarginRow } from "../../lib/pricing/margin";
import type { StoredRoundingPolicy } from "../../lib/money/rounding-policy";
import type { Schedule } from "../../lib/scheduling/window";
import type { FilterAst } from "../segments.server";
import type { ProductStatus } from "../../lib/campaigns/product-status";
import { DEFAULT_CONFIRM_ABOVE_VARIANTS, type BlastRadius } from "../../lib/campaigns/blast-radius";
import type { StartConfirmation } from "../../lib/campaigns/start-confirmation";

export interface CampaignInput {
  name: string;
  ast: FilterAst;
  rule: AdjustmentRule;
  compareAtPolicy: CompareAtPolicy;
  /**
   * Rounding, per currency.
   *
   * Not a single choice: a campaign pricing into three markets prices in three
   * currencies, and the charm ending that reads as considered in one reads as broken in
   * another (E9).
   */
  rounding: StoredRoundingPolicy;
  guardrails?: Guardrails;
  priority?: number;
  /**
   * Price products that enter scope while the campaign runs. Defaults on: a merchant
   * who puts a collection on sale means the collection, not the products that
   * happened to be in it at the moment they clicked.
   */
  autoEnroll?: boolean;
  /** Absent means the campaign only runs when applied by hand. */
  schedule?: Schedule;
  /**
   * Product tags added when the campaign starts and removed when it ends.
   *
   * The storefront hook that lets the app ship no theme code at all: a theme keys its
   * sale badge off a tag, and nothing in the app touches the theme.
   */
  tagKit?: string[];
  /**
   * Practice: preview everything, write nothing, ever.
   *
   * Enforced in the run path rather than only in the UI, because a promise that
   * nothing will be written has to hold even if a button, a scheduler tick or a future
   * caller gets it wrong.
   */
  practice?: boolean;
  /**
   * Markets this campaign prices, alongside the base price.
   *
   * Empty means the base price only, which is what a single-market store wants and
   * what every campaign did before markets existed. Each entry is a price list gid;
   * the campaign computes each market's price from that market's own baseline, so a
   * market is a surface the campaign runs on, not a copy of the base result.
   */
  priceLists?: string[];
  /**
   * Target a saved segment instead of an inline filter.
   *
   * Stored as a reference, not copied, so editing the segment updates every campaign
   * using it -- which is what makes a segment reusable rather than a template.
   */
  segmentId?: string;
  /**
   * Product statuses this campaign covers (#751). Absent is active products only.
   *
   * Held by the campaign rather than by its filter or its segment, because it applies to
   * either: a segment is shared and means every status, and which of its products this
   * sale reaches is this campaign's decision.
   */
  productStatuses?: readonly ProductStatus[];
  /**
   * The typed confirmation given when it was saved with dates (#1009), kept with it so the
   * scheduler can start it with nobody there to ask. Written with the campaign, in one
   * statement: a scheduled campaign never exists unconfirmed for a moment it needed it.
   */
  startConfirmed?: StartConfirmation;
}

export interface PreviewRow {
  variantGid: string;
  title: string;
  /**
   * The campaign that owns this row.
   *
   * Usually the campaign being previewed, and uninteresting. It matters on a *revert*
   * preview, which plans with this campaign excluded: every row then belongs to whoever
   * keeps the variant afterwards, which is the answer to "what happens to my prices if I
   * end this sale" and the thing `docs/help/concepts/revert.md` argues about.
   *
   * The planner has always had it; the preview used to drop it.
   */
  campaignId?: string;
  before: string | null;
  after: string | null;
  compareAt: string | null;
  status: PlannedRow["status"];
  reason?: string;
  /**
   * What this variant does on each targeted market, keyed by price list gid.
   *
   * Absent for a base-only campaign. Present but missing a market means that market
   * has no price for this variant at all — a real state, and different from "no
   * change", which is why it is an absent key rather than a null price.
   */
  surfaces?: Record<string, SurfaceCell>;
}

/** One variant on one market, as the review step shows it. */
export interface SurfaceCell {
  after: string | null;
  compareAt: string | null;
  status: PlannedRow["status"];
  reason?: string;
}

/** The margin picture for a planned campaign. */
export interface MarginPreview {
  covered: number;
  unknown: number;
  averageBefore: number;
  averageAfter: number;
  averageDelta: number;
  belowTarget: MarginRow[];
  belowCost: MarginRow[];
  /** One sentence a merchant can act on. */
  summary: string;
}

/** How one market will be written, and why, in the merchant's own terms. */
export interface MarketPreview {
  priceListGid: string;
  name: string;
  currency: string;
  /**
   * "unknown" when the review step could not read the market's live settings. The two
   * real paths produce identical prices but are undone differently, so saying "unknown"
   * is materially better than guessing one of them.
   */
  path: "market-wide" | "per-product" | "unknown";
  explanation: string;
  /**
   * Products this market would skip or clamp, counted separately from the base
   * surface.
   *
   * A guardrail is per-currency: a floor that leaves every dollar price alone can
   * clamp half a market whose prices sit lower. Rolling the counts together would hide
   * exactly the market that needs looking at.
   */
  clamped: number;
  skipped: number;
  /**
   * This market will not be priced, and `explanation` says why.
   *
   * The only cause today is a price list that answers in a currency other than its own,
   * which the run refuses per market rather than failing the campaign over (#257). The
   * preview has to say the same thing: a merchant who is told nothing here, and then
   * sees one market missing from the run report, has been surprised by the product
   * rather than warned by it (#645).
   */
  refused: boolean;
}

export interface CampaignPreview {
  campaignId: string;
  name: string;
  status: string;
  counts: { planned: number; noop: number; skipped: number; clamped: number; clampedToMinimum: number };
  rows: PreviewRow[];
  /**
   * For a campaign that prices only its markets: every variant its markets are priced over,
   * which `rows` lists with the base price left as it is (#1111). `counts.planned` is the
   * base prices it writes, none, so it cannot be the table's total.
   */
  marketsOnlyVariants?: number;
  /** The first blocking variant, and every one of them in the merchant's words (#1076). */
  blocked?: { reason: string; variantGid: string; message: string };
  writePath: string;
  writePathReason: string;
  /**
   * The storefront tags Apply adds to each product it prices, as the campaign stores them
   * -- for the Apply dialog to name before it does (#759). Absent where nothing is planned.
   */
  tagKit?: string[];
  /** One entry per market this campaign also prices. Empty for base-only campaigns. */
  markets: MarketPreview[];
  /**
   * What this campaign does to margin, where cost is known.
   *
   * Null when the plan was blocked before it could be computed. Arithmetic on price and
   * cost — never an estimate for products with no cost, and never a claim about what the
   * campaign will earn, which needs order data and is a separate, approval-gated thing.
   */
  margin: MarginPreview | null;
  /**
   * Applying this needs "apply" typed first (A-3.11): over the store's variant threshold,
   * a price moving past its change threshold, or more than a handful taken to zero (#818).
   */
  blastRadius: boolean;
  /**
   * Why, for the dialog to say -- the same object the server's refusal is built from.
   * Absent where nothing was planned: a blocked plan, or a run writing the campaign.
   */
  confirm?: BlastRadius;
  /**
   * Set when this campaign cannot be applied as it is stored, saying why and what to do:
   * a reduction of 100% or more (#818). The run refuses it with the same sentence.
   */
  refused?: string;
  /**
   * Of the prices this would write, how many were changed outside the app while no
   * campaign was running on them, so their baselines are out of date (#745).
   */
  staleBaselines: number;
  /**
   * Set instead of a plan while a run is writing this campaign (#803): why the page shows
   * no preview. Planning the whole scope on every load held database connections the run
   * itself needed -- on a 102,132-variant apply, enough to starve every shop's pages.
   */
  writing?: string;
  /**
   * Set instead of a plan while this campaign's first plan is worked out in the background
   * (#812): its scope is too large to plan while the page loads, and nothing is stored yet.
   * The page says this rather than a preview of zeros, and offers no Apply until there is a
   * preview to confirm.
   */
  planning?: string;
  /**
   * Set over a stored plan that is not current (#812): something it depends on has changed
   * since it was worked out, and it is being worked out again. The page shows these numbers
   * -- the last it has -- with this sentence beside them, never as the answer, and the Apply
   * dialog asks for the word typed whatever they say.
   */
  recomputing?: string;
  /**
   * When the plan these numbers came from was made, for a stored one (#812): the page follows
   * a plan being worked out until a newer one is stored.
   */
  asOf?: string;
  /**
   * Every live campaign sharing this one's variants, and who prices them (#821). On a
   * revert preview, the ones that keep the variants this campaign gives up.
   */
  overlaps?: Overlap[];
  /**
   * `counts.noop` by who prices those variants (#837): this campaign, nobody, or another
   * campaign that outranks it, by name. Absent where there is no plan.
   */
  alreadyCorrect?: AlreadyCorrect;
  /**
   * The campaigns pricing every variant this one covers, when it prices none itself (#837).
   * Empty or absent otherwise. The status line reads it: "your storefront shows the campaign
   * price" is not true of a sale entirely under a higher-priority one.
   */
  outrankedBy?: string[];
}

export interface RunOutcome {
  runId: string;
  planned: number;
  verified: number;
  failed: number;
  unverified: number;
  clean: boolean;
  messages: string[];
  /**
   * Set when this call did not start a run because another process already owns the
   * same occurrence.
   *
   * Not an error: declining to double-apply is the constraint working. It is reported
   * rather than swallowed so a caller can tell "nothing to do" apart from "somebody
   * else is doing it", which are different things to show a merchant.
   */
  deferredTo?: string;
  /**
   * Set when the run was refused before it started, saying why.
   *
   * The shop's plan does not cover the campaign, or its scope is too large to finish
   * inside the caller's request. Distinct from a failure and from "nothing to do": a
   * caller showing a run report needs to say "your plan does not cover this" rather
   * than "your sale failed", and an empty `runId` alone cannot carry that difference.
   *
   * Named for the outcome rather than one of its causes, because a caller branching on
   * it is asking "did this run?" -- and it once said `ByPlan` while carrying a reason
   * that had nothing to do with billing.
   */
  refused?: string;
  /**
   * Set when the run was handed to the background worker rather than run here: a revert
   * too large for one request (#772). Nothing was written by this call; the worker writes.
   */
  queued?: boolean;
  /**
   * Set with `refused` when the reason will clear on its own -- another writer of this
   * campaign finishing, the worker's queue coming back. A caller that can retry (Shopify
   * Flow, which resends a 5xx) should; nothing about the campaign needs changing (#773).
   */
  transient?: boolean;
  /**
   * For a run over named variants: those whose base price the plan found already at the
   * campaign's price, so nothing was written for them (#1042). A variant the plan skipped,
   * or never had in scope, is not here; a put-back closes a drift only for these.
   */
  unchanged?: string[];
}

export interface RunSummary {
  id: string;
  kind: string;
  status: string;
  planned: number;
  verified: number;
  failed: number;
  skipped: number;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * Whether this run's email went out, in a sentence (#1123). Null for a run with no record,
   * which is every run from before the record existed. Absent while the deployment cannot
   * send email, when the app does not offer it at all.
   */
  email?: { text: string; toSettings: boolean } | null;
}

export interface LedgerRow {
  variantGid: string;
  title: string;
  /**
   * Which price this row is (#887): "Base price", or the market's or price list's name. A
   * campaign pricing markets writes a row per surface, and two rows of one variant read as
   * duplicates when nothing said which was which.
   */
  surface: string;
  /** The currency of this row's amounts, which differs from the shop's on a market's row. */
  currency: string;
  priceListGid: string;
  before: string | null;
  intended: string | null;
  status: string;
  failureReason: string | null;
}

/**
 * Campaigns changing more than this many variants require typed confirmation, until the
 * store sets its own number in Settings (#818).
 */
export const BLAST_RADIUS_THRESHOLD = DEFAULT_CONFIRM_ABOVE_VARIANTS;
