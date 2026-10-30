/**
 * How a run writes to its own database: in bounded batches, one after another, each batch
 * retried when the database says "not now" (#810).
 *
 * Measured on anchor-perf (#803): one 102k-variant run held the pool for forty minutes and
 * failed its own writes with P2024 (#802, #805). Two things made that worse than it had to
 * be, and this module is the answer to both.
 *
 * **Unbounded statements.** Several ledger writes took every row the run had -- a 102,132-
 * element `IN` list, a createMany of the whole plan -- in one call. Prisma splits those into
 * statements of up to 32,767 binds, inside one implicit transaction, so the run held a
 * connection and its row locks for as long as the biggest of them took, and the bind-limit
 * class of #346 waited one more filter away. A run now writes `RUN_CHUNK` rows a statement,
 * sequentially, so it holds one connection for one short statement at a time and a page
 * waiting for that connection waits for a statement, not for a run.
 *
 * **One transient error ended the run.** A pool timeout on chunk 41 of 102 threw out of
 * the run, which marked itself Partial over prices that had landed. P2024 and P2034 mean
 * the statement never committed -- no connection was had, or the transaction was rolled
 * back -- so the chunk is retried as it was, after a pause, and the run carries on.
 *
 * What a retry may never do is change anything else: it does not touch the run's claim
 * (#802), its row or its campaign's state. It retries one statement. Only when the retries
 * run out does the original error leave, and the run's own catch handles it exactly as it
 * always has -- Partial with what landed, never handed back as if nothing ran.
 *
 * Safe to retry because every write it wraps is idempotent or never ran: ledger inserts
 * are `skipDuplicates` over the row's unique key, status updates set a value rather than
 * moving one, and the counters (`attempt: { increment: 1 }`) are only retried on the two
 * codes that mean the statement did not commit. Never used inside an interactive
 * transaction: a P2034 there has aborted the whole transaction, not this statement.
 */

import { TRANSIENT_PRISMA_CODES } from "../errors/app-error";
import { logger } from "../logging/logger";
import { metric } from "../telemetry/metrics";
import { chunk } from "./chunk";

/**
 * Rows per write statement inside a run.
 *
 * #810's number: small enough that one statement holds a connection for milliseconds even
 * under contention, large enough that a 102,132-variant ledger is 103 statements rather than
 * thousands. Far under the bind ceiling whatever a where clause adds (`chunk.ts`).
 */
export const RUN_CHUNK = 1_000;

/**
 * Pauses before each retry. Three retries, a little over five seconds of pausing in all --
 * on top of the pool timeout each attempt already waited -- which outlasts a burst of page
 * traffic without leaving a run silent long enough for the reaper (five minutes) to wonder.
 */
export const RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000];

/** P2024 (no connection from the pool) or P2034 (rolled back by a conflict or deadlock). */
export function isTransientDbError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && TRANSIENT_PRISMA_CODES.has(code);
}

export interface RetryOptions {
  delaysMs?: readonly number[];
  /** For tests, which cannot wait five seconds per case. */
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs one statement, retrying it on a transient database error.
 *
 * `what` names the write in the log and on the `db.transient_retries` counter -- a short
 * fixed label such as `ledger.base.create`, never anything from the rows themselves, so no
 * price can reach either (CLAUDE.md).
 */
export async function retryTransient<T>(
  what: string,
  attempt: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? pause;

  for (let tried = 0; ; tried++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransientDbError(error)) throw error;
      const code = (error as { code: string }).code;
      if (tried >= delays.length) {
        metric("db.transient_retries", 1, { what, code, outcome: "gave_up" });
        logger.error("transient database error outlasted its retries", { what, code, attempts: tried + 1 });
        throw error;
      }
      const delayMs = delays[tried]!;
      metric("db.transient_retries", 1, { what, code, outcome: "retried" });
      logger.warn("transient database error; retrying the statement", { what, code, attempt: tried + 1, delayMs });
      await sleep(delayMs);
    }
  }
}

/**
 * Writes `items` in sequential batches of at most `size`, each one retried on its own.
 *
 * Sums the `count` each batch reports, for the `updateMany` callers that read it. A batch
 * that outlasts its retries throws, leaving the batches before it committed and the ones
 * after it unsent -- the shape the run's catch and Resume already handle, because it is
 * the shape a crash part-way leaves.
 */
export async function inRunChunks<T>(
  what: string,
  items: readonly T[],
  write: (batch: T[]) => Promise<unknown>,
  options: RetryOptions & { size?: number } = {},
): Promise<{ count: number }> {
  let count = 0;
  for (const batch of chunk(items, options.size ?? RUN_CHUNK)) {
    const result = await retryTransient(what, () => write(batch), options);
    const counted = (result as { count?: unknown } | undefined)?.count;
    if (typeof counted === "number") count += counted;
  }
  return { count };
}
