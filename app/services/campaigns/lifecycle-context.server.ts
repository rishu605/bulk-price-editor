import { endMissed } from "../../lib/scheduling/end-missed";
import { startRefusal } from "../../lib/scheduling/start-refusal";
import { neverStarts, parseSchedule, windowEndText } from "../../lib/scheduling/window";
import type { CampaignState } from "../../lib/lifecycle/transitions";
import { lateStart } from "./late-start.server";
import { partialProgress } from "./result.server";

/**
 * Everything the campaign page's Status card needs beyond the state itself: what the state
 * means for this campaign right now. One place, because each fix that made the card tell
 * the truth (#702, #784, #824, #837, #851, #927, #975, #1005) added a line to the page's
 * loader, and the route has a size it must stay under.
 */
export async function lifecycleContext(
  shopId: string,
  campaignId: string,
  state: CampaignState,
  schedule: unknown,
  timeZone: string,
  outrankedBy: readonly string[] | undefined,
) {
  return {
    ...(state === "PARTIAL" ? await partialProgress(shopId, campaignId) : {}), // #702, #927
    heldUntil: state === "HELD" ? windowEndText(schedule, timeZone) : undefined, // #784
    neverStarts: state === "SCHEDULED" ? neverStarts(parseSchedule(schedule), new Date(), timeZone) : null, // #824
    outrankedBy, // a higher campaign prices every variant (#837)
    startRefused: state === "SCHEDULED" ? startRefusal(schedule) : null, // #975
    lateStart: state === "SCHEDULED" ? await lateStart(shopId, campaignId, schedule) : null, // #851
    endMissed: state === "ACTIVE" ? endMissed(schedule) : null, // #1005
  };
}
