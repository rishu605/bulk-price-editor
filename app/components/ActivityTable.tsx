import { formatWhen } from "../lib/format/display";
import type { ActivityEntry } from "../lib/reporting/activity-csv";
import { describeActor } from "../lib/audit/actor";

/**
 * Every state-changing action, with who and what changed.
 *
 * A separate component like every other table in the app. That is not only tidiness:
 * rendering `s-table` inline in a route alongside a filter form reliably produced a
 * blank page here, where the same markup in its own component renders fine.
 */
export function ActivityTable({
  entries,
  timeZone,
}: {
  entries: ActivityEntry[];
  timeZone: string;
}) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header>When</s-table-header>
        <s-table-header>Who</s-table-header>
        <s-table-header>Action</s-table-header>
        <s-table-header>What changed</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {entries.map((entry) => (
          <s-table-row key={entry.id}>
            <s-table-cell>{formatWhen(entry.at, timeZone)}</s-table-cell>
            {/* Unattended work is the scheduler, and saying so beats an empty cell
                somebody has to guess at. Staff show as an id rather than a name: the
                session token carries the id, and names would mean online tokens. */}
            <s-table-cell>{describeActor(entry.actor)}</s-table-cell>
            <s-table-cell>{entry.action}</s-table-cell>
            <s-table-cell>{entry.summary}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

