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

/** The keys that say when a campaign runs. Everything else in the blob is what it prices. */
export const WINDOW_KEYS = ["kind", "startAt", "endAt", "revertBufferMinutes", "clockNotes"] as const;

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
