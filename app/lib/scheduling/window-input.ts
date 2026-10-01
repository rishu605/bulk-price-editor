/**
 * Whether a typed window can ever run, said before a campaign is saved with it (#760).
 *
 * The create action took any pair of dates. An end before the start made a campaign that
 * sat in Scheduled forever -- `dueTransition` never applies a window that has closed, and
 * nothing reverts what never applied -- and the only sign was a warning on the campaign
 * page *after* it had been created. Nothing on that page could fix it either.
 *
 * Each problem names the field, so the merchant knows which of four inputs to change.
 */

import {
  clockNote,
  formatScheduleInstant,
  joinDateAndTime,
  resolveLocalInput,
  utcToLocalInput,
  type Schedule,
} from "./window";

/** The four schedule fields as the forms post them: dates, and optional 24-hour times. */
export interface WindowFields {
  startDate?: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
}

/**
 * The window the four fields describe, in UTC, read in the store's zone.
 *
 * One reading for the create form and the edit-dates dialog, so the same typed values
 * schedule the same instants from both. A time the clocks skip or repeat is resolved by
 * P3.9's rule and comes back as a note to show.
 */
export function windowFromFields(
  fields: WindowFields,
  timeZone: string,
): { startUtc: string | null; endUtc: string | null; clockNotes: string[] } {
  const startLocal = joinDateAndTime(fields.startDate ?? "", fields.startTime ?? "", "09:00");
  const endLocal = joinDateAndTime(fields.endDate ?? "", fields.endTime ?? "", "23:59");
  const start = startLocal ? resolveLocalInput(startLocal, timeZone) : null;
  const end = endLocal ? resolveLocalInput(endLocal, timeZone) : null;

  return {
    startUtc: start?.utc ?? null,
    endUtc: end?.utc ?? null,
    clockNotes: [
      start && clockNote("starts", startLocal, start, timeZone),
      end && clockNote("ends", endLocal, end, timeZone),
    ].filter((note): note is string => !!note),
  };
}

export interface WindowInput {
  /** The start, as UTC ISO, or null when none was given. */
  startUtc: string | null;
  /** The end, as UTC ISO, or null for a window that runs until reverted by hand. */
  endUtc: string | null;
  now: Date;
  /** Formats an instant the way the merchant reads it -- the store's zone. */
  describe: (iso: string) => string;
  /**
   * Refuse a start that has already passed.
   *
   * Off when creating: a window whose start has just passed is applied on the next tick,
   * which is what somebody setting up a sale that "starts now" means. On when editing a
   * scheduled campaign's dates, where a past start would turn "change the date" into "start
   * the sale" -- Apply already says that plainly.
   */
  futureStart?: boolean;
}

export function windowInputProblem(input: WindowInput): string | null {
  const { startUtc, endUtc, now, describe } = input;

  if (!startUtc) {
    return endUtc
      ? "Start: an end was given without a start. Add a start date, or clear End to leave the campaign unscheduled."
      : null;
  }

  const start = Date.parse(startUtc);
  if (input.futureStart && start <= now.getTime()) {
    return (
      `Start: ${describe(startUtc)} has already passed. Choose a later start, or use Apply to ` +
      "storefront to start the campaign now."
    );
  }

  if (!endUtc) return null;
  const end = Date.parse(endUtc);

  if (end <= start) {
    return (
      `End: ${describe(endUtc)} is not after the start, ${describe(startUtc)}, so this campaign ` +
      "would never apply. Choose a later end, or leave End empty to run until you revert it."
    );
  }
  if (end <= now.getTime()) {
    return (
      `End: ${describe(endUtc)} has already passed, so this campaign would never apply. ` +
      "Choose a later end, or leave End empty to run until you revert it."
    );
  }

  return null;
}

/**
 * A window as the edit-dates dialog shows it: the dates as its fields take them, and the
 * start as the call-off dialog names it. Null for a campaign that runs by hand.
 */
export function scheduledWindow(
  schedule: Schedule,
  timeZone: string,
): { start: string; end: string; startText: string } | null {
  if (schedule.kind !== "window") return null;
  return {
    start: utcToLocalInput(schedule.startAt, timeZone),
    end: utcToLocalInput(schedule.endAt, timeZone),
    startText: `${formatScheduleInstant(schedule.startAt, timeZone)} (${timeZone})`,
  };
}
