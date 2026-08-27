import { describeAction, iconForAction } from "../lib/audit/action";
import { describeActor } from "../lib/audit/actor";
import { collapseRuns, type Loggable } from "../lib/audit/collapse";
import { formatAgo } from "../lib/format/display";
import { SPACE } from "../lib/ui/spacing";

/**
 * The last few things that happened, in the sidebar.
 *
 * It was five lines of `market.added · Scheduler · 27/08/2026, 12:40:38` — the same
 * sentence five times, in a column 22rem wide. Three separate problems wearing one
 * coat, and all three are fixed here rather than in the loader, because the data was
 * never wrong:
 *
 * - **The action was a machine string.** `market.added` is what the audit table stores
 *   and it is the right thing to store; it is not a thing to show a merchant.
 * - **The timestamp was absolute, to the second.** Five of those stacked vertically are
 *   five nearly identical strings that have to be diffed character by character to
 *   answer "was this recent?".
 * - **Repeats were repeated.** One sync writes one entry per market it finds, so the
 *   whole list was routinely one event, five times.
 *
 * What is deliberately kept: the actor on every row. This is an audit trail, and "who"
 * is half of what it is for — a feed that folded staff and the scheduler together to
 * look tidier would be answering a different question than the one being asked.
 */
export function ActivityFeed<T extends Loggable>({
  entries,
  now,
  timeZone,
}: {
  entries: T[];
  now: string;
  timeZone: string;
}) {
  return (
    <s-stack gap={SPACE.section}>
      {collapseRuns(entries).map(({ entry, count }) => (
        <s-grid
          key={entry.id}
          // The glyph column is fixed by its content and the text takes the rest, so a
          // long action name wraps under itself rather than under the icon.
          gridTemplateColumns="auto 1fr"
          gap={SPACE.item}
          alignItems="start"
        >
          <s-icon type={iconForAction(entry.action)} color="subdued" />
          <s-stack gap={SPACE.tight}>
            <s-stack direction="inline" gap={SPACE.item} alignItems="center">
              <s-text type="strong">{describeAction(entry.action)}</s-text>
              {count > 1 ? <s-badge tone="neutral">{`×${count}`}</s-badge> : null}
            </s-stack>
            <s-text color="subdued">
              {/* "latest" only when the row stands for several entries. Without it the
                  time reads as *the* time this happened, which for a folded run is true
                  of exactly one of them. */}
              {describeActor(entry.actor)} · {count > 1 ? "latest " : ""}
              {formatAgo(entry.at, now, timeZone)}
            </s-text>
          </s-stack>
        </s-grid>
      ))}
    </s-stack>
  );
}
