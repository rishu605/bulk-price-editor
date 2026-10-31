/**
 * What archiving a campaign leaves running, said before it is archived (#748).
 *
 * Archiving is allowed in any state (`setArchived`, D19): it files a campaign away and
 * changes nothing it does. That was true and said nowhere. "Sale · 21/09/2026", Active, went
 * from More actions → Archive straight out of the list with its prices live, and a "Black
 * Friday 2026" archived in October would still go live on 27 Nov, from a list the merchant
 * could no longer see it in.
 *
 * So the states in which something keeps happening are named once, here, and three places
 * read them: the confirmation Archive asks for, the count the campaigns list carries, and
 * the tone of the Archived badge.
 */

import { PRICES_MAY_BE_LIVE, type CampaignState } from "../lifecycle/transitions";
import { formatScheduleInstant, parseSchedule } from "../scheduling/window";

/**
 * The states in which an archived campaign is still doing something to the storefront:
 * prices that may be live, or a start still to come. Draft, completed and cancelled have
 * neither, and archiving one of those stays one click.
 */
export const RUNS_WHEN_ARCHIVED: ReadonlySet<CampaignState> = new Set<CampaignState>([...PRICES_MAY_BE_LIVE, "SCHEDULED"]);

/** The Archived badge: a warning on a campaign still running, a tag on one that is done. */
export function archivedTone(state: CampaignState): "warning" | "neutral" {
  return RUNS_WHEN_ARCHIVED.has(state) ? "warning" : "neutral";
}

export interface ArchiveWarning {
  /** What keeps happening, with its date in the store's zone where it has one. */
  keeps: string;
  /** What would stop it, which archiving does not. */
  instead: string | null;
}

/**
 * What the Archive confirmation says, or null where archiving asks nothing.
 *
 * `label` is the lifecycle badge's: a start in doubt -- refused, never opening, waiting on a
 * confirmation -- reads "Scheduled — …" there, and this does not promise it. A practice
 * campaign writes nothing, ever, so archiving one leaves nothing running.
 */
export function archiveWarning(
  state: CampaignState,
  rawSchedule: unknown,
  timeZone: string,
  label: string,
  practice: boolean,
  now: Date = new Date(),
): ArchiveWarning | null {
  if (practice || !RUNS_WHEN_ARCHIVED.has(state)) return null;

  const schedule = parseSchedule(rawSchedule);
  const at = (iso: string) => `${formatScheduleInstant(iso, timeZone)} (${timeZone})`;
  // Its end while that is still ahead. Past it, the scheduler is already ending it and the
  // badge says so; with none, nothing ends it but a revert.
  const until =
    schedule.kind !== "window" || !schedule.endAt
      ? " It runs until you revert it."
      : Date.parse(schedule.endAt) > now.getTime()
        ? ` The schedule still reverts it ${at(schedule.endAt)}.`
        : "";
  const revert = "To take its prices down, revert it instead.";

  switch (state) {
    case "SCHEDULED":
      if (schedule.kind !== "window") return { keeps: "It is still scheduled.", instead: null };
      return {
        keeps: label.includes(" — ")
          ? `It is still scheduled to start ${at(schedule.startAt)}.`
          : `It will still start ${at(schedule.startAt)}, and its prices go live then.`,
        instead: "To stop it starting, close this and use Cancel or unschedule.",
      };
    case "ACTIVE":
      return { keeps: `Its prices stay live on your storefront.${until}`, instead: revert };
    case "HELD":
      return {
        keeps: `Its prices stay live on your storefront, and the edits holding it still wait in the drift queue.${until}`,
        instead: revert,
      };
    case "PARTIAL":
      return {
        keeps: "Some of its prices stay live on your storefront, and its run stays stopped part way.",
        instead: "To finish it, resume it or revert it instead.",
      };
    case "APPLYING":
      // Revert is offered once the run has finished, not while it writes.
      return {
        keeps: `It is writing its prices to your storefront now, and they stay live.${until}`,
        instead: "To take its prices down, revert it once it has finished.",
      };
    case "REVERTING":
      return { keeps: "It is taking its prices down now, and the ones it has not reached yet stay live until it finishes.", instead: null };
    default:
      return null;
  }
}
