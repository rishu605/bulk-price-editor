/**
 * A campaign's state as every list of campaigns shows it (#1056): the campaigns list, Home's
 * upcoming campaigns and the calendar.
 *
 * What a row can tell from the campaign alone, beside its state -- a window that can never
 * open (#824), a start refused for good (#975), a sale still applying past its start or its
 * end (#829, #1056), a run the background worker could not run (#1046). Each list had its own map from state to badge, so "Applying — ending
 * late" in the list was "Applying" on Home and on the calendar beside it. The campaign
 * page's Status card says more, from what only it loads; see `lifecycleContext`.
 */

import { describeState, type CampaignState, type StateDescription } from "../lifecycle/transitions";
import { queuedRefusal } from "./queued-refusal";
import { endingLateText, startingLateText } from "../scheduling/ending-late";
import { startRefusal } from "../scheduling/start-refusal";
import { neverStarts, parseSchedule } from "../scheduling/window";

/**
 * The row's label and tone. In UTC: a row shows the label, not the reason, so the zone the
 * reason is written in does not matter.
 */
export function lifecycleOf(state: CampaignState, schedule: unknown, now: Date): StateDescription {
  return describeState(state, {
    neverStarts: state === "SCHEDULED" ? neverStarts(parseSchedule(schedule), now, "UTC") : null,
    startRefused: state === "SCHEDULED" ? startRefusal(schedule) : null,
    endingLate: endingLateText(schedule, state, "UTC", now),
    startingLate: startingLateText(schedule, state, "UTC", now),
    queuedRefused: queuedRefusal(schedule), // a run the worker could not run (#1046)
  });
}

/** Only what a badge shows, for the lists that pass it to the browser: Home's and the calendar's. */
export function lifecycleBadge(state: CampaignState, schedule: unknown, now: Date): { label: string; tone: string } {
  const { label, tone } = lifecycleOf(state, schedule, now);
  return { label, tone };
}
