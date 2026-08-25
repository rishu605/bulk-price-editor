/**
 * The activity log as CSV.
 *
 * Client-safe, like the rollback export and for the same reason: the download is built
 * in the browser from data the page already holds, because a resource route cannot
 * authenticate inside an embedded app's iframe. A serialiser living beside the query
 * in a `.server` module would be stripped from the client bundle and be `undefined` at
 * the moment somebody clicked Export.
 */

import { toCsv } from "./csv";

export interface ActivityEntry {
  id: string;
  at: string;
  /** Null for the scheduler and other unattended work. */
  actor: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  summary: string;
}

export function activityCsv(entries: readonly ActivityEntry[]): string {
  return toCsv(
    ["timestamp", "actor", "action", "entity", "entity_id", "change"],
    entries.map((entry) => [
      entry.at,
      // "system" rather than blank: an empty cell in an exported audit log reads as
      // missing data rather than as unattended work.
      entry.actor ?? "system",
      entry.action,
      entry.entity ?? "",
      entry.entityId ?? "",
      entry.summary,
    ]),
  );
}
