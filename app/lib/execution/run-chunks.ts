/**
 * Writing a large run in chunks, a turn on the worker's large lane each (#809, D34).
 *
 * A run was one job from its plan to its end. On Shopify's bulk path -- every run over
 * `DEFAULT_THRESHOLD` rows -- that job held an `execution` slot for as long as Shopify took over
 * the whole operation, so two shops' 100k-variant applies held both of the lane's slots and a
 * third shop's 500-variant run waited for one of them to finish. A worker restarted mid-run left
 * its run to the reaper, Partial, and Resume replanned the whole campaign to find what was left.
 *
 * Now a run of more than `RUN_CHUNK_ROWS` prices on the bulk path, written by the worker, plans
 * once: its first turn runs every gate, ledgers every price it will write and ends. Each turn
 * after that takes the next `RUN_CHUNK_ROWS` PENDING rows of its ledger, sends them as one bulk
 * operation, reads them back, records them and goes to the back of the lane, behind whoever is
 * waiting. The ledger is the plan, so nothing is planned twice: a turn after a restart starts at
 * the next unwritten row. The last turn does what the one job did after its prices -- tags,
 * market prices, the mirror, the run's counts and the campaign's state -- so a merchant reads one
 * run, one history entry and one "Writing N of M" from its first price to its last.
 */

import { CLAMP_REASONS } from "../campaigns/clamp-reasons";
import { money } from "../money/money";
import type { ResolutionReason } from "../pricing/types";
import type { PlannedRow } from "../planning/types";

/**
 * The prices one turn writes. Picked from the code's own numbers for the bulk path, which is
 * the only path a run this large takes:
 *
 * - **Shopify's share.** 1.75 ms a variant, measured on anchor-perf with 62,535 variants in
 *   one operation (`inline-budget.ts`): about nine seconds for five thousand.
 * - **The operation's own.** A staged upload, the submission, a poll every five seconds
 *   (`BULK_POLL_INTERVAL_MS`) and the result file cost the same for five rows as for five
 *   thousand, and are of the same order as those nine seconds. Much smaller, and they are the
 *   run: at the bulk threshold itself (1,000 rows) Shopify's share is under two seconds, and a
 *   100k run would be a hundred operations. Much larger, and a turn is the slot held end to end
 *   again: at 60,000 rows Shopify's share alone is the two minutes `SMALL_RUN_MS` calls short.
 *
 * So a turn holds a large-lane slot for well under a minute, a shop waiting behind two 100k
 * runs waits about one turn rather than a whole run, and a run alone on the lane takes at most
 * about twice as long as one operation would. A turn's ledger is five `RUN_CHUNK` statements.
 */
export const RUN_CHUNK_ROWS = 5_000;

/**
 * How many times the reaper gives a chunked run back to the queue after a turn's process
 * stopped responding. Past it the run is reclaimed as Partial, as any dead run is: a chunk that
 * kills its worker every time must not be retried for ever.
 */
export const MAX_TURN_RESTARTS = 3;

/**
 * The rows a turn of this run writes, or null when it is written in one call. Only a run on the
 * bulk path, and only one larger than a chunk: a sync-path run is at most `DEFAULT_THRESHOLD`
 * rows, minutes by the inline budget's figures, and a run of one chunk gains nothing by waiting
 * for a second turn to write it.
 */
export function chunkRowsFor(rows: number, path: "sync" | "bulk", size = RUN_CHUNK_ROWS): number | null {
  return path === "bulk" && size > 0 && rows > size ? size : null;
}

/**
 * What a chunked run's last turn needs from its plan, and what its turns have said so far.
 * Kept on its `run_chunks` row (`carry`), so any worker can take any turn. Counts, short lists
 * of sentences, and the variants its tags and markets cover -- never a price.
 */
export interface ChunkCarry {
  /** Who asked, and what for: the options the run's last turn acts on. */
  actor: string;
  revert: boolean;
  resume: boolean;
  keepEdited: boolean;
  /** Handed to the worker by a press or Flow (#1046): a run that ends before it writes says so. */
  queued: boolean;
  /** The state the scheduler or a press claimed the campaign from, as `RunOptions` has it. */
  claimedFrom?: string;
  /** Where the campaign's claim goes back to when the run ends having written nothing. */
  releaseTo?: string;
  /** A whole-campaign revert, which takes back everything the campaign wrote (#828). */
  wholeRevert: boolean;
  /** When the plan started, for the run's duration. Epoch milliseconds. */
  startedAt: number;
  /** The plan's counts, as `PlanCounts` has them. */
  counts: { planned: number; skipped: number; clamped: number; noop: number };
  /** Why the plan left rows alone, in the merchant's words (`describeSkips`). */
  skips: string[];
  /** What a resume left untouched, for its first message. */
  resumedFrom: { verified: number; quarantined: number } | null;
  /** A bulk operation an earlier run sent, settled before this one planned (#832). */
  settledNote: string | null;
  /** Edits a resumed revert kept (#1157), and the rows this run spared. */
  kept: number;
  spared: number;
  /** Prices a whole revert had no baseline to take back (#828). */
  unplanned: number;
  /** Said before any price was written: the market baselines' messages. */
  before: string[];
  /** Markets refused while their baselines were read, which the market step must not price. */
  refusedMarkets: string[];
  /** The run a resume continues, whose landed market rows it leaves alone (#841). */
  marketsLandedIn?: string;
  /** Every variant whose markets and tags this run covers (`marketScope`, with its followers). */
  marketVariants: string[];
  /** A revert's variants and the campaign that prices each after it, for takeover tags (#687). */
  winners: Array<[variantGid: string, campaignId: string]>;
  /** Why rows failed, from the turns that wrote them: the first few, for the run's messages. */
  failures: string[];
}

/** How many failure sentences a carry keeps: the run's messages show five at most. */
export const CARRY_FAILURES = 5;

/** What a turn reads of a ledger row to write it again as the plan wrote it. */
export interface PendingLedgerRow {
  variantGid: string;
  currency: string;
  beforePrice: bigint | null;
  beforeCompareAt: bigint | null;
  intendedPrice: bigint | null;
  intendedCompareAt: bigint | null;
  intendedCompareAtSet: boolean;
  /** A clamped row's reason, written with the ledger (`CLAMP_REASONS`); null otherwise. */
  failureReason: string | null;
}

const CLAMP_BY_TEXT = new Map(CLAMP_REASONS.map(([reason, text]) => [text, reason]));

/**
 * A base-price ledger row as the row the plan wrote it from: the same price, compare-at and
 * clamp. What the executor and `recordResults` read of a planned row is all in the ledger, so a
 * turn writes exactly what the plan decided without planning it again.
 */
export function plannedRowOf(row: PendingLedgerRow): PlannedRow {
  const amount = (value: bigint | null) => (value === null ? undefined : money(Number(value), row.currency));
  const clamp = row.failureReason ? CLAMP_BY_TEXT.get(row.failureReason) : undefined;
  return {
    ref: { variantGid: row.variantGid, surfaceKind: "base", priceListGid: "", currency: row.currency },
    beforePrice: amount(row.beforePrice),
    beforeCompareAt: amount(row.beforeCompareAt),
    intendedPrice: amount(row.intendedPrice),
    // Null with the flag set is "clear it"; the flag unset is "leave it alone".
    intendedCompareAt: row.intendedCompareAt === null ? (row.intendedCompareAtSet ? null : undefined) : amount(row.intendedCompareAt),
    intendedCompareAtSet: row.intendedCompareAtSet,
    status: clamp ? "clamped" : "pending",
    ...(clamp ? { reason: clamp as ResolutionReason } : {}),
  };
}
