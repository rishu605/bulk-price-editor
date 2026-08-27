import { Link } from "react-router";

import type { CalendarDay } from "../lib/scheduling/calendar";
import { CAMPAIGN_TONE, toneFor } from "./tone";

/**
 * The grid itself.
 *
 * Deliberately not an `s-table`. A calendar is a grid of boxes rather than rows of
 * cells, and `s-table` blanks the whole page past a few hundred of them — a six-week
 * month with a few campaigns a day would sail past that.
 *
 * Each day links into the wizard pre-dated, because the fastest path from "I want a sale
 * that weekend" to a campaign is clicking the weekend.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarGrid({ days, today }: { days: CalendarDay[]; today: string }) {
  if (days.length === 0) {
    return <s-paragraph>Nothing scheduled in this period.</s-paragraph>;
  }

  return (
    <s-stack gap="small">
      {/* Which column is which day. Without it the grid is seven anonymous boxes and a
          merchant has to count from the first date to work out whether a sale lands on
          a weekend — which is usually the thing they came to check. */}
      <s-grid gridTemplateColumns="repeat(7, 1fr)" gap="small-200">
        {WEEKDAYS.map((weekday) => (
          <s-box key={weekday} padding="small-200">
            <s-text color="subdued">{weekday}</s-text>
          </s-box>
        ))}
      </s-grid>

      {/* A real grid rather than rows of boxes, so every day is the same width and the
          columns line up under their weekday. Stacked boxes sized themselves to their
          contents, which put a busy Tuesday under Wednesday's heading. */}
      {chunk(days, 7).map((week) => (
        <s-grid key={week[0].date} gridTemplateColumns="repeat(7, 1fr)" gap="small-200">
          {week.map((day) => (
            <s-box key={day.date} padding="small-200" borderWidth="base" borderRadius="base">
              <s-stack gap="small-500">
                <Link to={`/app/campaigns/new?startAt=${day.date}`}>
                  <s-text tone={day.date === today ? "info" : day.inFocus ? "auto" : "neutral"}>
                    {dayNumber(day.date)}
                    {day.date === today ? " · today" : ""}
                  </s-text>
                </Link>

                {day.entries.map((entry) => (
                  <Link
                    key={`${day.date}-${entry.campaignId}`}
                    to={`/app/campaigns/${entry.campaignId}`}
                  >
                    <s-badge tone={toneFor(CAMPAIGN_TONE, entry.status)}>
                      {/* Only the starting day carries the name. Repeating it on every
                          day of a two-week sale turns the grid into a wall of the same
                          words and hides the days something actually happens. */}
                      {entry.starts ? entry.name : entry.continues ? "→" : "·"}
                    </s-badge>
                  </Link>
                ))}

                {/* What actually happened that day, as distinct from what was
                    scheduled. A campaign set for the 3rd that ended up partial on the
                    4th is a merchant's whole question, and a calendar showing only the
                    intention cannot answer it. */}
                {day.runs.map((run) => (
                  <Link key={run.runId} to={`/app/campaigns/${run.campaignId}`}>
                    <s-text tone={run.status === "COMPLETED" ? "success" : "critical"}>
                      {run.kind === "REVERT" ? "reverted" : "applied"}
                      {run.status === "COMPLETED" ? "" : ` · ${run.status.toLowerCase()}`}
                    </s-text>
                  </Link>
                ))}

                {day.entries.length > 1 ? (
                  <s-badge tone="warning">{day.entries.length} overlap</s-badge>
                ) : null}
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      ))}
    </s-stack>
  );
}

function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
