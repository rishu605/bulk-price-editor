import { startConfirmationOf, unconfirmedStart } from "../../lib/campaigns/start-confirmation";
import { endMissed } from "../../lib/scheduling/end-missed";
import { endingLateText } from "../../lib/scheduling/ending-late";
import { startRefusal } from "../../lib/scheduling/start-refusal";
import { neverStarts, parseSchedule, windowEndText } from "../../lib/scheduling/window";
import type { CampaignState } from "../../lib/lifecycle/transitions";
import { lateStart } from "./late-start.server";
import { partialProgress } from "./result.server";
import type { CampaignPreview } from "./types";

/**
 * Everything the campaign page's Status card needs beyond the state itself: what the state
 * means for this campaign right now. One place, because each fix that made the card tell
 * the truth (#702, #784, #824, #837, #851, #927, #975, #1005, #1009, #829) added a line to the page's
 * loader, and the route has a size it must stay under.
 */
export async function lifecycleContext(
  shopId: string,
  campaignId: string,
  state: CampaignState,
  schedule: unknown,
  timeZone: string,
  preview: Pick<CampaignPreview, "outrankedBy" | "confirm">,
) {
  return {
    ...(state === "PARTIAL" ? await partialProgress(shopId, campaignId) : {}), // #702, #927
    heldUntil: state === "HELD" ? windowEndText(schedule, timeZone) : undefined, // #784
    neverStarts: state === "SCHEDULED" ? neverStarts(parseSchedule(schedule), new Date(), timeZone) : null, // #824
    outrankedBy: preview.outrankedBy, // a higher campaign prices every variant (#837)
    startRefused: state === "SCHEDULED" ? startRefusal(schedule) : null, // #975
    lateStart: state === "SCHEDULED" ? await lateStart(shopId, campaignId, schedule) : null, // #851
    endMissed: state === "ACTIVE" ? endMissed(schedule) : null, // #1005
    // From the page's own preview, the reach the start check reads (#1009).
    unconfirmedStart: state === "SCHEDULED" && preview.confirm ? unconfirmedStart(preview.confirm, startConfirmationOf(schedule)) : null,
    endingLate: endingLateText(schedule, state, timeZone, new Date()), // still applying when its revert was due (#829)
  };
}
