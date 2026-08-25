/**
 * Shared types for the campaign services.
 *
 * Kept separate from the modules that use them so create/preview/run/history can
 * each stay focused without importing one another just for a type.
 */

import type { AdjustmentRule, CompareAtPolicy, Guardrails } from "../../lib/pricing/types";
import type { PlannedRow } from "../../lib/planning/types";
import type { StoredRoundingPolicy } from "../../lib/money/rounding-policy";
import type { Schedule } from "../../lib/scheduling/window";
import type { FilterAst } from "../segments.server";

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
}

export interface PreviewRow {
  variantGid: string;
  title: string;
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
}

export interface CampaignPreview {
  campaignId: string;
  name: string;
  status: string;
  counts: { planned: number; noop: number; skipped: number; clamped: number };
  rows: PreviewRow[];
  blocked?: { reason: string; variantGid: string };
  writePath: string;
  writePathReason: string;
  /** One entry per market this campaign also prices. Empty for base-only campaigns. */
  markets: MarketPreview[];
  /** Campaigns over this size need typed confirmation (A-3.11). */
  blastRadius: boolean;
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
   * Set when the shop's plan does not cover this campaign, so no run was started.
   *
   * Distinct from a failure and from "nothing to do". A caller showing a run report
   * needs to say "your plan does not cover this" rather than "your sale failed", and an
   * empty `runId` alone cannot carry that difference.
   */
  refusedByPlan?: string;
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
}

export interface LedgerRow {
  variantGid: string;
  title: string;
  before: string | null;
  intended: string | null;
  status: string;
  failureReason: string | null;
}

/** Campaigns changing more than this many variants require typed confirmation. */
export const BLAST_RADIUS_THRESHOLD = 1_000;
