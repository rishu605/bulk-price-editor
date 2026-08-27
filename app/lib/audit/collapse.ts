/**
 * Folding a repeated action into one line.
 *
 * The dashboard shows the five most recent audit entries, and a single sync writes one
 * entry per market it discovers — so the whole list is routinely five copies of "market
 * added, scheduler, 12:40:38", and the merchant learns nothing except that the app is
 * busy. Five rows spent on one event is also five rows *not* spent on the four other
 * things that happened.
 *
 * Only *consecutive* runs fold, and the log is ordered, so a folded row is a true
 * statement about a contiguous stretch of history: nothing else happened in between. The
 * alternative — grouping by action across the whole list — would silently reorder events
 * and imply an adjacency that was not there.
 */

export interface Loggable {
  id: string;
  actor: string | null;
  action: string;
  at: string;
}

export interface CollapsedRun<T extends Loggable> {
  /** The most recent entry of the run; its timestamp is the one worth showing. */
  entry: T;
  /** How many consecutive entries folded into it. One means nothing was folded. */
  count: number;
}

export function collapseRuns<T extends Loggable>(entries: T[]): Array<CollapsedRun<T>> {
  const runs: Array<CollapsedRun<T>> = [];

  for (const entry of entries) {
    const previous = runs[runs.length - 1];
    // Actor as well as action: the scheduler adding a market and a member of staff adding
    // one are the same event with different accountability, and the audit log exists for
    // the accountability.
    if (previous && previous.entry.action === entry.action && previous.entry.actor === entry.actor) {
      previous.count += 1;
      continue;
    }
    runs.push({ entry, count: 1 });
  }

  return runs;
}
