/**
 * Tone vocabulary shared by the tables.
 *
 * Polaris accepts a fixed set of tone keywords; typing the maps here means a typo
 * fails the build rather than silently rendering an untoned badge.
 */

export type Tone =
  | "auto"
  | "neutral"
  | "info"
  | "success"
  | "caution"
  | "warning"
  | "critical";

/** Campaign lifecycle states. */
export const CAMPAIGN_TONE: Record<string, Tone> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  APPLYING: "info",
  ACTIVE: "success",
  HELD: "warning",
  REVERTING: "info",
  COMPLETED: "info",
  PARTIAL: "warning",
  CANCELLED: "neutral",
};

/** Run outcomes. `PARTIAL` is warning, never success -- it is not a clean run. */
export const RUN_TONE: Record<string, Tone> = {
  PLANNING: "info",
  QUEUED: "info",
  EXECUTING: "info",
  VERIFYING: "info",
  COMPLETED: "success",
  PARTIAL: "warning",
  FAILED: "critical",
  CANCELLED: "neutral",
};

/** Per-row ledger states. */
export const LEDGER_TONE: Record<string, Tone> = {
  PENDING: "info",
  WRITING: "info",
  APPLIED: "info",
  VERIFIED: "success",
  FAILED: "critical",
  SKIPPED: "neutral",
  CLAMPED: "warning",
  REVERTED: "neutral",
};

/** Planned-row states shown in a preview. */
export const PREVIEW_TONE: Record<string, Tone> = {
  pending: "info",
  clamped: "warning",
  skipped: "neutral",
};

export function toneFor(map: Record<string, Tone>, key: string): Tone {
  return map[key] ?? "neutral";
}
