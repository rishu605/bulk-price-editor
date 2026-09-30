/**
 * Which key a scheduled transition should run under, given the runs its occurrence
 * already has (#700).
 *
 * An occurrence key is stable on purpose: two ticks that both find a window due produce
 * the same key, and the unique index turns the second into a no-op. But a stable key also
 * collides with the occurrence's own *finished* run. A scheduled revert that ended
 * PARTIAL, threw, or was reaped after a worker died was claimed again by the next tick,
 * hit its own old run on the index, "stood down" to a run that was not running, and left
 * the campaign REVERTING forever with its sale prices live.
 *
 * So each retry of an occurrence gets its own key -- `REVERT@<end>`, then `…#2`, `…#3` --
 * which keeps the no-double-run guarantee per attempt. A worker restart mid-revert (every
 * deploy) is retried rather than left on sale. After `MAX_ATTEMPTS` the scheduler stops
 * and leaves the campaign as its last attempt left it: visibly PARTIAL, with Revert and
 * Resume available to the merchant.
 */

/** First run plus two retries. A failure that survives three attempts needs a person. */
export const MAX_ATTEMPTS = 3;

/** Run states with a process still behind them. */
const LIVE = new Set(["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"]);

export interface OccurrenceRun {
  occurrenceKey: string | null;
  status: string;
}

/**
 * The key for the next attempt at `base`, or null to leave the occurrence alone this tick:
 * an attempt is still running, or every attempt has been used.
 */
export function nextAttemptKey(base: string, runs: readonly OccurrenceRun[]): string | null {
  const attempts = runs.filter(
    (run) => run.occurrenceKey === base || run.occurrenceKey?.startsWith(`${base}#`),
  );

  if (attempts.some((run) => LIVE.has(run.status))) return null;
  if (attempts.length === 0) return base;
  if (attempts.length >= MAX_ATTEMPTS) return null;
  return `${base}#${attempts.length + 1}`;
}
