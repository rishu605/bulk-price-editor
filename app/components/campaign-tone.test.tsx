/**
 * One tone per campaign state, wherever the state is drawn (#1016).
 *
 * There were two maps. The list's status badge and the campaign page took their tone from
 * `describeState`; the calendar and Home's upcoming list took theirs from `CAMPAIGN_TONE`.
 * They agreed until they did not: a Partial campaign was red in the list, as a run that
 * did not finish should be, and amber on the calendar beside it -- the same campaign
 * saying two different things about how worried to be.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CalendarGrid } from "./CalendarGrid";
import { CAMPAIGN_TONE, toneFor } from "./tone";
import { ALL_STATES, describeState, STATE_TONE } from "../lib/lifecycle/transitions";
import { layOut, monthRange } from "../lib/scheduling/calendar";

describe("one tone map for campaign status", () => {
  it.each(ALL_STATES)("%s has the same tone in the list's badge and on the calendar", (state) => {
    expect(toneFor(CAMPAIGN_TONE, state)).toBe(describeState(state).tone);
  });

  it("is the lifecycle's own map, not a copy of it", () => {
    expect(CAMPAIGN_TONE).toBe(STATE_TONE);
  });

  it("draws a Partial campaign critical on the calendar, as the list does", () => {
    const days = layOut(
      [{ id: "p", name: "Half done", status: "PARTIAL", startAt: "2026-10-05T09:00:00.000Z", endAt: null }],
      monthRange(2026, 10),
      "UTC",
      { year: 2026, month: 10 },
    );
    const html = renderToStaticMarkup(<CalendarGrid days={days} today="2026-10-14" />);
    const named = /<s-badge tone="([^"]*)">Half done<\/s-badge>/.exec(html);

    expect(named?.[1]).toBe("critical");
    expect(describeState("PARTIAL").tone).toBe("critical");
  });
});
