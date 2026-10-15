/**
 * The two halves of a campaign's `schedule` column.
 *
 * `createCampaign` keeps four things that decide a price in that JSON -- the filter, the
 * segment id, the rounding and whether it is practice -- beside the window that says when
 * it runs, "so the shape can evolve without a migration". Anything that copies or clears
 * "the schedule" has to tell the halves apart: Duplicate dropped the whole blob to avoid
 * re-arming last month's dates, and its copy priced the entire catalogue, could be applied
 * though its source was practice, and lost its rounding (#762).
 */

import { START_CONFIRMED_KEY } from "./start-confirmation";

/**
 * The keys that say when a campaign runs. Everything else in the blob is what it prices.
 *
 * `startRefused` is a start the scheduler was refused for good (#975): it belongs to the
 * dates, so a copy, an unschedule or new dates leave it behind.
 *
 * Not `startConfirmed` (#1009), which is about what the campaign writes: see `OWN_KEYS`.
 */
export const WINDOW_KEYS = ["kind", "startAt", "endAt", "revertBufferMinutes", "clockNotes", "zone", "startRefused", "endMissed"] as const;

/** The blob without its window: the campaign's definition, which a copy keeps. */
export function definitionOf(schedule: unknown): Record<string, unknown> {
  const rest = { ...((schedule ?? {}) as Record<string, unknown>) };
  for (const key of WINDOW_KEYS) delete rest[key];
  return rest;
}

/** The definition, run by hand: what a campaign with no dates stores. */
export function manualSchedule(schedule: unknown): Record<string, unknown> {
  return { ...definitionOf(schedule), kind: "manual" };
}

/**
 * Keys that belong to this campaign's own record rather than to what it prices or when.
 *
 * `startConfirmed` is a person's typed confirmation of what this campaign reaches (#1009). It
 * is not a window key: moving the dates changes nothing the campaign writes, and every start
 * is checked against it anyway. But a copy is a new campaign that person never confirmed.
 */
export const OWN_KEYS = [START_CONFIRMED_KEY] as const;

/** What a copy stores: the definition, run by hand, without the source's own record. */
export function copiedSchedule(schedule: unknown): Record<string, unknown> {
  const copy = manualSchedule(schedule);
  for (const key of OWN_KEYS) delete copy[key];
  return copy;
}
