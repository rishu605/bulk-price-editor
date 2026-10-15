/**
 * A scheduled campaign still applying when its revert was due (#829).
 *
 * On anchor-perf a 30-minute sale over 102,132 variants was still applying 56 minutes after
 * its window closed. The scheduler reverts only a campaign whose apply has finished
 * (`dueTransition`), and it has to: one run writes a campaign's prices at a time (rule 2),
 * and a revert written under a running apply would be overwritten by it. So the end waits
 * for the start. What was wrong was that nothing said so -- the page read "Applying", no
 * email went out, and the sale outlived its window with the merchant none the wiser.
 *
 * From the moment its revert was due, a campaign still applying reads "ending late", the
 * merchant is told once, and the revert begins as soon as the apply finishes.
 */

import { formatScheduleInstant, parseSchedule, revertMoment, windowEndText, type Schedule } from "./window";

/** Where the telling is kept, in the campaign's `schedule` JSON beside the end it is about. */
export const ENDING_LATE_KEY = "endingLate";

interface StoredLate {
  /** The end the merchant was told about, so a new one (the dates moved) is told afresh. */
  endAt: string;
  at: string;
}

/** Whether a campaign is ending late: still applying at or past the moment its revert was due. */
export function isEndingLate(schedule: Schedule, status: string, now: Date): boolean {
  if (status !== "APPLYING") return false;
  const due = revertMoment(schedule);
  return due !== null && now.getTime() >= due;
}

/**
 * When the window of a campaign ending late ends, as the page writes it, or null when it is
 * not ending late. Derived rather than read from the mark, so the page says it whether or
 * not the telling has happened yet.
 */
export function endingLateText(raw: unknown, status: string, timeZone: string, now: Date): string | null {
  return isEndingLate(parseSchedule(raw), status, now) ? (windowEndText(raw, timeZone) ?? null) : null;
}

/** The schedule blob with the merchant recorded as told that its current end is late. */
export function withEndingLate(schedule: unknown, at: Date): Record<string, unknown> {
  const blob = { ...((schedule ?? {}) as Record<string, unknown>) };
  const endAt = typeof blob.endAt === "string" ? blob.endAt : "";
  const stored: StoredLate = { endAt, at: at.toISOString() };
  return { ...blob, [ENDING_LATE_KEY]: stored };
}

/** Whether the merchant has been told this campaign's current end is late. */
export function toldEndingLate(schedule: unknown): boolean {
  const blob = (schedule ?? {}) as Record<string, unknown>;
  const stored = blob[ENDING_LATE_KEY] as Partial<StoredLate> | undefined;
  if (!stored || typeof stored.endAt !== "string" || typeof blob.endAt !== "string") return false;
  return Date.parse(stored.endAt) === Date.parse(blob.endAt);
}

/** The campaign's history entry for it, said once, by the scheduler. */
export const ENDING_LATE_ENTRY =
  "still applying when its revert was due, so the sale ends late: it reverts as soon as the apply finishes";

/**
 * How long past its start a scheduled apply may still be writing before it reads as late
 * (#1056). The scheduler ticks every thirty seconds, so every scheduled apply begins a little
 * after its start, and a small one finishes in seconds; neither is late.
 */
export const STARTING_LATE_GRACE_MS = 2 * 60_000;

/**
 * When the window opened, as the page writes it, for a campaign still applying more than
 * `STARTING_LATE_GRACE_MS` after it (#1056) -- its sale reaching the storefront late -- or null.
 * Null once it is ending late, which says more.
 */
export function startingLateText(raw: unknown, status: string, timeZone: string, now: Date): string | null {
  const schedule = parseSchedule(raw);
  if (status !== "APPLYING" || schedule.kind !== "window" || isEndingLate(schedule, status, now)) return null;
  if (now.getTime() < Date.parse(schedule.startAt) + STARTING_LATE_GRACE_MS) return null;
  return `${formatScheduleInstant(schedule.startAt, timeZone)} (${timeZone})`;
}

