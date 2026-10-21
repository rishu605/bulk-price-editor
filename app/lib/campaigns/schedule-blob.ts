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

import { QUEUED_REFUSED_KEY } from "./queued-refusal";
import { START_CONFIRMED_KEY } from "./start-confirmation";

/**
 * The keys that say when a campaign runs. Everything else in the blob is what it prices.
 *
 * `startRefused` is a start the scheduler was refused for good (#975): it belongs to the
 * dates, so a copy, an unschedule or new dates leave it behind. So do `endMissed` (#1005)
 * and `endingLate` (#829), which are about one end.
 *
 * Not `startConfirmed` (#1009), which is about what the campaign writes: see `OWN_KEYS`.
 */
export const WINDOW_KEYS = [
  "kind",
  "startAt",
  "endAt",
  "revertBufferMinutes",
  "clockNotes",
  "zone",
  "startRefused",
  "endMissed",
  "endingLate",
] as const;

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
 *
 * `queuedRefused` is a run of this campaign's the worker refused (#1046): a copy never ran.
 */
export const OWN_KEYS = [START_CONFIRMED_KEY, QUEUED_REFUSED_KEY] as const;

/** Where the blob says a campaign is practice; `isPractice` reads it. */
const PRACTICE_KEY = "practice";

/**
 * What a copy stores: the definition, run by hand, without the source's own record.
 *
 * A practice campaign's copy is practice (#762). `real` is the one exception, and the only
 * difference: a practice campaign's "Make a real copy" (#1077), which prices exactly what its
 * source previewed and can be applied. The flag is part of the definition, so dropping it is
 * asked for by name rather than being something a copy might do by accident.
 */
export function copiedSchedule(schedule: unknown, options: { real?: boolean } = {}): Record<string, unknown> {
  const copy = manualSchedule(schedule);
  for (const key of OWN_KEYS) delete copy[key];
  if (options.real) delete copy[PRACTICE_KEY];
  return copy;
}
