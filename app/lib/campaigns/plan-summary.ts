/**
 * The rules for reading a stored plan summary, kept pure so each can be tested on its own
 * (#812). The database half -- the snapshot, the log, the job -- is `plan-summary.server.ts`.
 *
 * The campaign page used to plan its whole campaign on every load and every tab switch, its
 * Apply press planned it again before the run planned it a third time, and the Revert dialog
 * planned it once more with the campaign left out. At 102,132 variants one plan took 2 min
 * 20 s on an idle server and pushed every shop's `/healthz` to 3-5 s (#803). The answers are
 * now stored per campaign and read; these rules decide when a stored answer may be read as
 * the answer, and what the page says when it may not.
 */

import { countOf, formatWhen } from "../format/display";

/**
 * Past this age a summary is stale whatever the log says.
 *
 * Two things a summary depends on are not in the database to be logged. How each market is
 * written is read from Shopify's own market settings while planning, and a percentage the
 * merchant moves in Shopify admin reaches the mirror only with the next markets sync. And
 * the log is pruned (`PLAN_INPUT_RETENTION_MS`), so a summary older than the oldest row kept
 * could miss a write the pruning removed. Six hours bounds the first, and sits well inside
 * the second.
 */
export const PLAN_SUMMARY_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * How long the log of writes is kept. Any summary planned before the oldest row still kept
 * is past `PLAN_SUMMARY_MAX_AGE_MS`, and stale by age, so pruning can never make a stale
 * summary look current.
 */
export const PLAN_INPUT_RETENTION_MS = 2 * 24 * 60 * 60_000;

/**
 * How long a background plan that was asked for may go unanswered before a page asks again:
 * a job the worker lost, or one that failed every attempt. Longer than the slowest plan
 * measured (2 min 20 s at 102,132 variants, three of them for a campaign that can be
 * reverted), so a plan still running is never asked for twice.
 */
export const PLAN_REQUEST_QUIET_MS = 10 * 60_000;

/** The campaign states a run is writing in, when the page shows the run instead of a plan (#803). */
export const PLAN_IN_FLIGHT: ReadonlySet<string> = new Set(["APPLYING", "REVERTING"]);

/** The states in which a campaign has prices of its own live, and a rollback report to show. */
export const REVERTABLE: ReadonlySet<string> = new Set(["ACTIVE", "PARTIAL", "HELD"]);

export type SummaryState = "current" | "stale" | "missing";

/**
 * Whether a stored summary is the answer now.
 *
 * `changed` is the database's word: a write logged for the shop that the summary's snapshot
 * did not see. Anything unknown is stale -- a summary with no snapshot, a date that does not
 * parse -- because a stale one read as current is the failure this exists to prevent, and a
 * current one read as stale costs only a plan.
 */
export function summaryState(
  row: { preview: unknown; computedAt: Date | null; snapshot: string | null } | null,
  changed: boolean,
  now: Date,
): SummaryState {
  if (!row || row.preview === null || row.preview === undefined || !row.computedAt) return "missing";
  if (!row.snapshot || changed) return "stale";
  const age = now.getTime() - row.computedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > PLAN_SUMMARY_MAX_AGE_MS) return "stale";
  return "current";
}

/**
 * Whether a page should ask the worker for a plan: nothing asked yet, the last ask answered
 * (the plan it led to began after it), or the last ask gone quiet. Otherwise one is on its way.
 */
export function shouldRequest(
  row: { requestedAt: Date | null; computedAt: Date | null } | null,
  now: Date,
): boolean {
  if (!row?.requestedAt) return true;
  if (row.computedAt && row.computedAt.getTime() >= row.requestedAt.getTime()) return true;
  return now.getTime() - row.requestedAt.getTime() > PLAN_REQUEST_QUIET_MS;
}

/**
 * Said above a summary that is not current, on every tab, and in the Apply and Revert
 * dialogs: what the numbers are, why they may be wrong, and that they are being redone. Never
 * a price -- this is page copy, but it is built where telemetry is too, and it needs none.
 */
export function recomputingText(asOf: Date | string, timeZone: string): string {
  return (
    `These numbers were worked out at ${formatWhen(new Date(asOf).toISOString(), timeZone)}, and something they depend on ` +
    "has changed since: the catalogue, a baseline, another campaign or a setting. They are being worked out again, " +
    "and this page updates when they are ready."
  );
}

/** Said in place of a preview when none has been worked out yet, and one is on its way. */
export function planningText(variants: number): string {
  return (
    `Working out what this campaign would do. It covers ${countOf(variants, "variant")}, too many to plan while this ` +
    "page loads, so it is planned in the background, and this page updates when it is ready. Apply is offered once " +
    "there is a preview to confirm."
  );
}
