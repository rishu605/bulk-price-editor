/**
 * How long a run that is still writing has left, from what it has been seen to write (#820).
 *
 * The PRD asks for an "ETA from observed throughput", and the word that matters is
 * *observed*. This divides the rows the run has written, as its heartbeat last said, by how
 * long it has been going, and puts the rest at that rate. Where that would be a guess it says
 * nothing, because a merchant told "about 2 minutes" who is still waiting at ten stops
 * believing the page:
 *
 * - **Before 5% of its rows.** A run's first seconds are setup: the ledger written ahead,
 *   the write intents, the market baselines read before any price. A rate taken from a
 *   handful of rows mostly measures that.
 * - **A bulk operation.** Its rows go to Shopify as one operation, which writes them all and
 *   answers once, so the run counts none until it is over and there is no rate to observe.
 *   The run's summary already says what it is waiting on (`describeRun`).
 * - **A run gone quiet.** Nothing heard from it for `QUIET_AFTER_MS`. An average from before
 *   it went quiet promises an end it is not working towards.
 * - **Every row written.** What is left after them (the read-back, tags, market prices) is
 *   not in these rows, and "under a minute" over three minutes of tagging is exactly the guess this
 *   exists not to make. Past 100% is the same answer.
 * - **No start time.** Nothing to divide by.
 *
 * Whole minutes, and "under a minute" below one. Seconds from an average are a precision the
 * estimate does not have, and the page asks again every five of them.
 */

/** How far a run in flight has got, as its heartbeat last said (`runEtaOf`). */
export interface RunProgress {
  /** How its rows go to Shopify. Null until the run has chosen. */
  path: "SYNC" | "BULK" | null;
  /** The rows it writes. */
  rows: number;
  /** Of those, the ones the executor has sent and had answered, failures included. */
  written: number;
  startedAt: Date | null;
  /** Stamped as it works (`heartbeat` in run.server.ts). */
  heartbeatAt: Date | null;
}

/** How much of its rows a run has written before its rate is read. */
export const ETA_AFTER_PERCENT = 5;

/**
 * How long a run may go unheard before its rate stops counting. Its heartbeat is stamped at
 * most every five seconds while it writes (`HEARTBEAT_EVERY_MS`), so a minute is a dozen
 * stamps missed: slow is still answered, silent is not.
 */
export const QUIET_AFTER_MS = 60_000;

const MINUTE_MS = 60_000;

/** "about 4 minutes left", "under a minute left", or null where the rate cannot be seen. */
export function runEta(progress: RunProgress, now: Date): string | null {
  const { path, rows, written, startedAt } = progress;
  if (path !== "SYNC" || !startedAt || rows <= 0) return null;

  if (written * 100 < rows * ETA_AFTER_PERCENT || written >= rows) return null;

  const lastHeard = progress.heartbeatAt ?? startedAt;
  if (now.getTime() - lastHeard.getTime() > QUIET_AFTER_MS) return null;

  // A start stamped by a clock ahead of this one.
  const elapsed = now.getTime() - startedAt.getTime();
  if (elapsed <= 0) return null;

  const left = ((rows - written) * elapsed) / written;
  if (left < MINUTE_MS) return "under a minute left";
  const minutes = Math.round(left / MINUTE_MS);
  return minutes === 1 ? "about a minute left" : `about ${minutes} minutes left`;
}
