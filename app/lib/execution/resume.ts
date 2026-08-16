/**
 * Resuming an interrupted run.
 *
 * The guarantee (edge case E2): a run killed at any point and resumed converges to
 * exactly the state a clean run would have produced. That is what makes deploying
 * mid-run safe, and it rests on one rule -- **a verified row is never touched
 * again**.
 *
 * Verified means read back from Shopify and confirmed, not merely written. The
 * distinction matters: a row we wrote but could not read back may or may not have
 * landed, so it is re-planned. Rewriting an already-correct price is a no-op; failing
 * to rewrite one that never landed is a wrong price on a live storefront.
 *
 * This is also what makes job re-delivery harmless. A duplicate delivery re-plans
 * only non-verified rows, and on a completed run that set is empty.
 */

import type { PlannedRow } from "../planning/types";

/** The ledger states a row can be in when a run is picked back up. */
export type LedgerState =
  | "PENDING"
  | "WRITING"
  | "APPLIED"
  | "VERIFIED"
  | "FAILED"
  | "SKIPPED"
  | "CLAMPED"
  | "REVERTED";

export interface PriorRow {
  variantGid: string;
  status: LedgerState;
  attempt: number;
}

export interface ResumePlan {
  /** Rows to work on this time. */
  todo: PlannedRow[];
  /** Verified last time, deliberately left alone. */
  alreadyVerified: number;
  /** Quarantined: attempts exhausted, not retried again. */
  quarantined: number;
}

/**
 * States that count as settled -- a resumed run must not touch them.
 *
 * SKIPPED and CLAMPED are settled because they were decisions, not failures: the row
 * was deliberately not written, and re-deciding it would produce the same answer.
 */
const SETTLED: ReadonlySet<LedgerState> = new Set<LedgerState>([
  "VERIFIED",
  "SKIPPED",
  "CLAMPED",
  "REVERTED",
]);

/**
 * Works out what a resumed run should do.
 *
 * `maxAttempts` bounds retries per row so a poison row cannot make a run immortal --
 * it is counted as quarantined and the run moves on.
 */
export function planResume(
  planned: readonly PlannedRow[],
  prior: readonly PriorRow[],
  maxAttempts = 5,
): ResumePlan {
  const byGid = new Map(prior.map((row) => [row.variantGid, row]));

  const todo: PlannedRow[] = [];
  let alreadyVerified = 0;
  let quarantined = 0;

  for (const row of planned) {
    const previous = byGid.get(row.ref.variantGid);

    // Never seen before: a fresh row, or a row added to scope since the last attempt.
    if (!previous) {
      todo.push(row);
      continue;
    }

    if (SETTLED.has(previous.status)) {
      if (previous.status === "VERIFIED") alreadyVerified++;
      continue;
    }

    // Attempts exhausted. Left as it is, with its reason, so the run can end and the
    // merchant can see precisely which rows never made it.
    if (previous.attempt >= maxAttempts) {
      quarantined++;
      continue;
    }

    // PENDING, WRITING, APPLIED or FAILED with attempts left. APPLIED is included on
    // purpose: written but never read back is exactly the ambiguity a resume exists
    // to settle.
    todo.push(row);
  }

  return { todo, alreadyVerified, quarantined };
}

/**
 * The run's outcome.
 *
 * `clean` requires every row to be settled -- anything else is `partial`. There is
 * deliberately no way to report success with outstanding rows: that is precisely the
 * behaviour this product exists not to have.
 */
export function runOutcome(rows: readonly PriorRow[]): {
  clean: boolean;
  verified: number;
  outstanding: number;
} {
  let verified = 0;
  let outstanding = 0;

  for (const row of rows) {
    if (row.status === "VERIFIED") verified++;
    else if (!SETTLED.has(row.status)) outstanding++;
  }

  return { clean: outstanding === 0, verified, outstanding };
}

/**
 * A stable fingerprint of a run's final state, for the resume-equivalence test.
 *
 * Sorted by variant so ordering differences -- which a resumed run will always have,
 * since it processes a subset -- do not register as a difference in outcome.
 */
export function stateChecksum(
  rows: ReadonlyArray<{
    variantGid: string;
    status: LedgerState;
    price: bigint | number | null;
  }>,
): string {
  return [...rows]
    .map((row) => `${row.variantGid}:${row.status}:${row.price ?? "null"}`)
    .sort()
    .join("|");
}
