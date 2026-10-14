/**
 * A scheduled start refused for a reason no retry can change (#975).
 *
 * The scheduler claims a due campaign and runs it; a run that throws gives the claim back to
 * SCHEDULED, and the next tick claims it again. For a blip -- Shopify unreachable, the
 * database busy, a throttle -- that is the point: the sale starts as soon as the blip passes.
 * For a refusal it is not. A deleted segment, a blocking guardrail, a practice campaign: each
 * says no on every tick, and each tick wrote the claim and its release to the campaign's
 * history, every thirty seconds, for as long as the window stayed open.
 *
 * So the two are told apart by the error's class, and a refusal is recorded on the campaign
 * beside the start it refused. The scheduler leaves that start alone from then on; the page
 * says why the campaign has not started and what to do. Moving its dates is a new start, and
 * the scheduler tries that one.
 */

import { AppError, toAppError, type ErrorCode } from "../errors/app-error";

/**
 * The codes that describe the campaign or the shop's own settings rather than the moment.
 *
 * VALIDATION is the campaign itself saying no: practice, its segment deleted (#776), a state
 * that does not allow the run. GUARDRAIL_BLOCKED is the merchant's floor doing its job, which
 * `AppError` already calls never worth retrying. Each needs a person, and asking again every
 * thirty seconds changes nothing.
 *
 * Deliberately not here: everything `retryable` (throttled, Shopify or the database
 * unavailable), lost sessions -- the store reconnects and the schedule carries on (#707) --
 * and UNKNOWN, which is whatever we failed to classify. Getting this wrong in that direction
 * costs a quiet retry; getting it wrong in the other leaves a sale unstarted for good.
 */
const NO_RETRY_CHANGES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["VALIDATION", "GUARDRAIL_BLOCKED"]);

/**
 * The refusal as the merchant reads it, when no retry can change it; null when the next tick
 * should try again.
 *
 * VALIDATION counts only when somebody raised it on purpose, as an `AppError`. The same code
 * is what `toAppError` makes of a raw database constraint error, and that is our failure, not
 * a reason in the campaign the merchant could go and fix.
 */
export function refusedForGood(error: unknown): AppError | null {
  const app = toAppError(error);
  if (app.retryable || !NO_RETRY_CHANGES.has(app.code)) return null;
  if (app.code === "VALIDATION" && !(error instanceof AppError)) return null;
  // Not a refusal: it wrote, and the campaign is Partial with a Resume (#802). It keeps the
  // code of whatever stopped it, so the code alone would call it one.
  if (app.context.stoppedPartWay) return null;
  return app;
}

/** Where the refusal is kept, in the campaign's `schedule` JSON beside the window it refused. */
export const START_REFUSED_KEY = "startRefused";

interface StoredRefusal {
  /** The start that was refused, so a new one (the dates moved) is tried afresh. */
  startAt: string;
  /** The merchant's sentence: what is wrong and what to do about it. */
  reason: string;
  at: string;
}

/** The schedule blob with this start recorded as refused. */
export function withStartRefused(schedule: unknown, reason: string, at: Date): Record<string, unknown> {
  const blob = { ...((schedule ?? {}) as Record<string, unknown>) };
  const startAt = typeof blob.startAt === "string" ? blob.startAt : "";
  const stored: StoredRefusal = { startAt, reason, at: at.toISOString() };
  return { ...blob, [START_REFUSED_KEY]: stored };
}

/**
 * Why this campaign's current start was refused for good, or null when it was not.
 *
 * Null as soon as the start moves: the refusal belonged to the old one, and a merchant who
 * fixed the cause and moved the dates expects the new ones to run.
 */
export function startRefusal(schedule: unknown): string | null {
  const blob = (schedule ?? {}) as Record<string, unknown>;
  const stored = blob[START_REFUSED_KEY] as Partial<StoredRefusal> | undefined;
  if (!stored || typeof stored.reason !== "string" || typeof stored.startAt !== "string") return null;
  if (blob.kind !== "window" || typeof blob.startAt !== "string") return null;
  const same = Date.parse(stored.startAt) === Date.parse(blob.startAt);
  return same ? stored.reason : null;
}

/** The campaign's history entry for it: said once, by the scheduler, when it gives the claim back. */
export function startRefusedEntry(reason: string): string {
  return `couldn't start on schedule, and the schedule won't try this start again: ${reason}`;
}
