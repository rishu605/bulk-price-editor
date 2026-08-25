/**
 * Shared types for the campaign services.
 *
 * Kept separate from the modules that use them so create/preview/run/history can
 * each stay focused without importing one another just for a type.
 */

import type { AdjustmentRule, CompareAtPolicy, Guardrails } from "../../lib/pricing/types";
import type { PlannedRow } from "../../lib/planning/types";
import type { Schedule } from "../../lib/scheduling/window";
import type { FilterAst } from "../segments.server";

export interface CampaignInput {
  name: string;
  ast: FilterAst;
  rule: AdjustmentRule;
  compareAtPolicy: CompareAtPolicy;
  rounding: "none" | "charm99";
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
