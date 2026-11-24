/**
 * Where a run in flight has got, in a word or a few, from its row (#808).
 *
 * A run handed to the worker answers its request in a second, so the page has to say what
 * happens after: Queued, then Planning, then Writing N of M, then Verifying, and the page
 * reloads into the finished campaign when it is done. Before #808 it said "Applying" and
 * "Waiting for the background worker" for minutes, and a page that never changes reads as a
 * run that is stuck (#790).
 *
 * All of it is the row: its status, which the run moves as it goes, and #820's progress
 * columns, which its heartbeat keeps. Nothing is counted from the ledger, which settles at
 * the end (`runEta` says why).
 */

import { formatCount } from "../format/display";

/** What `runPhase` reads of a run row. */
export interface RunPhaseRow {
  status: string;
  writePath?: "SYNC" | "BULK" | null;
  writtenRows?: number | null;
  writableRows?: number | null;
}

/**
 * "Queued", "Planning", "Writing 1,200 of 4,000 prices", "Verifying"; null for a run that is
 * not in flight. A run that has not reported a count yet -- or a row read without its counts --
 * is "Writing prices", never "Writing 0 of 0".
 */
export function runPhase(run: RunPhaseRow): string | null {
  switch (run.status) {
    case "QUEUED":
      return "Queued";
    case "PLANNING":
      return "Planning";
    case "VERIFYING":
      return "Verifying";
    case "EXECUTING":
      break;
    default:
      return null;
  }

  const rows = run.writableRows ?? 0;
  const written = run.writtenRows ?? 0;
  if (rows <= 0) return "Writing prices";
  // A bulk operation writes every row at Shopify and answers once, so it counts none until
  // it is over: what it is waiting on, rather than "0 of 62,535" for an hour.
  if (run.writePath === "BULK" && written < rows) return `Writing ${formatCount(rows)} prices as one Shopify bulk operation`;
  // Every price sent and answered: the read-back, then tags and market prices, are what is left.
  if (written >= rows) return "Verifying";
  return `Writing ${formatCount(written)} of ${formatCount(rows)} prices`;
}

/** What the header says the background worker is doing in each phase before a price is written. */
export const WAITING_TEXT: Record<"Queued" | "Planning", string> = {
  Queued: "Waiting for the background worker",
  Planning: "The background worker is working out each price",
};
