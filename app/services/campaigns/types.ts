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
  /** Absent means the campaign only runs when applied by hand. */
  schedule?: Schedule;
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
