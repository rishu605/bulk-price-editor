/**
 * The campaign's own record in its `schedule` JSON: neither when it runs nor what it prices.
 *
 * Since #1141 the blob holds two things. The window -- its kind, dates, revert buffer, clock
 * notes and zone, and what became of one start or end (`startRefused`, `endMissed`,
 * `endingLate`) -- and beside it these keys, which belong to the campaign rather than to any
 * dates. What it prices has columns of its own (#884), and no blob holds a copy any more.
 *
 * `startConfirmed` is a person's typed confirmation of what the campaign reaches (#1009):
 * moving the dates changes nothing it writes, and every start is checked against it anyway.
 * `queuedRefused` is a run of this campaign's the worker refused (#1046), standing until a
 * later run claims it. So an unschedule and new dates keep both and nothing else of the old
 * blob; a copy keeps neither, being a new campaign nobody confirmed and that never ran, and
 * starts from `{ kind: "manual" }`.
 *
 * Kept by name, not by dropping the window's keys. A list of what to drop has to know every
 * key anybody ever wrote, and the one it missed rode along -- which is how a copy came to keep,
 * or lose, more than it meant to (#762). Moving these two into columns of their own is a
 * change of its own; until then this is the one list of them.
 */

import { QUEUED_REFUSED_KEY } from "./queued-refusal";
import { START_CONFIRMED_KEY } from "./start-confirmation";

/** The blob's keys that are the campaign's own record. */
export const OWN_KEYS = [START_CONFIRMED_KEY, QUEUED_REFUSED_KEY] as const;

/** The campaign's own record out of a schedule blob, and nothing else of it. */
export function ownRecordOf(schedule: unknown): Record<string, unknown> {
  if (schedule === null || typeof schedule !== "object" || Array.isArray(schedule)) return {};
  const blob = schedule as Record<string, unknown>;
  return Object.fromEntries(OWN_KEYS.filter((key) => Object.hasOwn(blob, key)).map((key) => [key, blob[key]]));
}
