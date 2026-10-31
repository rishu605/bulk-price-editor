/**
 * A campaign's state as every list of campaigns shows it (#1056): the campaigns list, Home's
 * upcoming campaigns and the calendar.
 *
 * What a row can tell from the campaign alone, beside its state -- a window that can never
 * open (#824), a start refused for good (#975), a sale still applying past its start or its
 * end (#829, #1056), a run the background worker could not run (#1046). Each list had its own map from state to badge, so "Applying — ending
 * late" in the list was "Applying" on Home and on the calendar beside it. The campaign
 * page's Status card says more, from what only it loads; see `lifecycleContext`.
 *
 * And from the count kept beside its stored plan, a baseline recaptured at its own sale price
 * (#1166): the page said "Active — needs a decision" and every list beside it "Active".
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
export function lifecycleOf(state: CampaignState, schedule: unknown, now: Date, recapturedAtSale = 0): StateDescription {
  return describeState(state, {
    recapturedAtSale, // a baseline recaptured at its sale price, as `recapturedAtSaleOf` reads it (#1166)
    neverStarts: state === "SCHEDULED" ? neverStarts(parseSchedule(schedule), now, "UTC") : null,
    startRefused: state === "SCHEDULED" ? startRefusal(schedule) : null,
    endingLate: endingLateText(schedule, state, "UTC", now),
    startingLate: startingLateText(schedule, state, "UTC", now),
    queuedRefused: queuedRefusal(schedule), // a run the worker could not run (#1046)
  });
}

/** Only what a badge shows, for the lists that pass it to the browser: Home's and the calendar's. */
export function lifecycleBadge(
  state: CampaignState,
  schedule: unknown,
  now: Date,
  recapturedAtSale = 0,
): { label: string; tone: string } {
  const { label, tone } = lifecycleOf(state, schedule, now, recapturedAtSale);
  return { label, tone };
}

/**
 * A row's count of baselines recaptured at its sale price, as the lists select it beside the
 * campaign (`RECAPTURED_COUNT`): zero for any state but Active, where it is the only thing that
 * needs a decision (#1166). Partial and Held need one already.
 */
export function recapturedAtSaleOf(state: CampaignState, planSummary: { recapturedAtSale: number | null } | null | undefined): number {
  return state === "ACTIVE" ? (planSummary?.recapturedAtSale ?? 0) : 0;
}
