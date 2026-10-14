/**
 * A campaign whose times were typed in one zone, on a store that is now in another (#799).
 *
 * Campaign times are stored as UTC instants, so a change of zone never moves a sale. It
 * moves the sale's *local* time instead: 09:00 typed while Anchor had the store in UTC is
 * 14:00 UTC, which a New York store reads as 09:00 only if New York was the zone it was
 * typed in. Before #799 every store was UTC until its first sync, and the sync then
 * changed the zone underneath every campaign already scheduled -- a 9 AM sale opened at
 * 4 AM, and nothing said so.
 *
 * So the zone is recorded with the times (`Schedule.zone`), and these decide, from it and
 * the store's zone now, which of a campaign's moments read differently on the store's
 * clock, and what keeping the typed time means. Pure: no database and no clock of its own.
 */

import {
  clockNote,
  formatScheduleInstant,
  resolveLocalInput,
  utcToLocalInput,
  type Schedule,
  type SchedulableStatus,
} from "./window";

/** Whether `zone` is an IANA zone this runtime can convert times in. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** One moment of a campaign whose time of day reads differently on the store's clock now. */
export interface MovedMoment {
  which: "start" | "end";
  /** The stored instant, UTC ISO. Unchanged by the zone change. */
  at: string;
  /** The wall-clock time it was set for, `YYYY-MM-DDTHH:MM` in the zone it was typed in. */
  typed: string;
  /** "1 Dec 2026, 09:00" -- as set, in the zone it was set in. */
  typedText: string;
  /** "1 Dec 2026, 04:00" -- the same instant on the store's clock now. */
  nowText: string;
}

export interface ZoneShift {
  /** The zone the times were typed in. */
  from: string;
  /** The store's zone now. */
  to: string;
  moments: MovedMoment[];
}

/**
 * Statuses whose start is still to come, and statuses whose end still is.
 *
 * In flight (APPLYING, REVERTING) is left out on purpose: a run is deciding from these
 * times right now, and moving them under it is what the reschedule refuses as well.
 */
const START_AHEAD: ReadonlySet<string> = new Set<SchedulableStatus>(["SCHEDULED"]);
const END_AHEAD: ReadonlySet<string> = new Set<SchedulableStatus>(["SCHEDULED", "ACTIVE", "HELD", "PARTIAL"]);

/**
 * Which of a campaign's moments now read differently on the store's clock, or null.
 *
 * Null when there is nothing to tell the merchant: no window, no record of the zone the
 * times were typed in (a campaign saved before #799, which is not guessed at), the same
 * zone, moments already behind it, or zones that happen to agree on those dates --
 * "Asia/Calcutta" and "Asia/Kolkata" are one clock under two names.
 */
export function zoneShiftOf(schedule: Schedule, status: string, storeZone: string, now: Date): ZoneShift | null {
  if (schedule.kind !== "window" || !schedule.zone) return null;
  const from = schedule.zone;
  if (from === storeZone || !isTimeZone(from) || !isTimeZone(storeZone)) return null;

  const candidates: Array<["start" | "end", string | undefined, boolean]> = [
    ["start", schedule.startAt, START_AHEAD.has(status)],
    ["end", schedule.endAt, END_AHEAD.has(status)],
  ];

  const moments: MovedMoment[] = [];
  for (const [which, at, open] of candidates) {
    if (!at || !open || Date.parse(at) <= now.getTime()) continue;
    const typed = utcToLocalInput(at, from);
    if (typed === utcToLocalInput(at, storeZone)) continue;
    moments.push({
      which,
      at,
      typed,
      typedText: formatScheduleInstant(at, from),
      nowText: formatScheduleInstant(at, storeZone),
    });
  }

  return moments.length > 0 ? { from, to: storeZone, moments } : null;
}

/**
 * The window with each moved moment back at the wall-clock time it was set for, now on
 * the store's clock: 09:00 in UTC becomes 09:00 in New York.
 *
 * A moment that did not move keeps its instant. A typed time the new zone's clocks skip
 * or repeat is resolved by the editor's own rule (P3.9) and comes back as a note, as it
 * would have if it had been typed in that zone to begin with; the old notes, which were
 * about the old zone, go when anything moves.
 */
export function keptWallClock(
  schedule: Extract<Schedule, { kind: "window" }>,
  shift: ZoneShift,
): { startUtc: string; endUtc: string | null; clockNotes: string[] } {
  const moved = new Map(shift.moments.map((moment) => [moment.which, moment]));
  const notes: string[] = [];

  const kept = (which: "start" | "end", at: string | undefined): string | null => {
    const moment = moved.get(which);
    if (!at || !moment) return at ?? null;
    const resolved = resolveLocalInput(moment.typed, shift.to);
    if (!resolved) return at;
    const note = clockNote(which === "start" ? "starts" : "ends", moment.typed, resolved, shift.to);
    if (note) notes.push(note);
    return resolved.utc;
  };

  const startUtc = kept("start", schedule.startAt) ?? schedule.startAt;
  const endUtc = kept("end", schedule.endAt);
  return { startUtc, endUtc, clockNotes: moved.size > 0 ? notes : (schedule.clockNotes ?? []) };
}

/**
 * The sentence for one campaign: what was set, and when that is on the store's clock now.
 *
 * "Its times were set in UTC, and Shopify has your store in America/New_York. On your
 * store's clock it starts 1 Dec 2026, 04:00, not 09:00 …". The typed time alone where the
 * date is the same on both clocks, so the merchant reads the difference rather than
 * diffing two full dates.
 */
export function describeZoneShift(shift: ZoneShift): string {
  const parts = shift.moments.map((moment) => {
    const verb = moment.which === "start" ? "starts" : "ends";
    return `${verb} ${moment.nowText}, not ${sameDayTime(moment) ?? moment.typedText}`;
  });
  return (
    `Its times were set in ${shift.from}, and Shopify has your store in ${shift.to}. On your ` +
    `store's clock it ${joinAnd(parts)}.`
  );
}

/** The typed time alone when it falls on the same date on both clocks. */
function sameDayTime(moment: MovedMoment): string | null {
  const [typedDate, typedTime] = splitText(moment.typedText);
  const [nowDate] = splitText(moment.nowText);
  return typedDate && typedDate === nowDate ? typedTime : null;
}

/** "1 Dec 2026, 09:00" -> ["1 Dec 2026", "09:00"]. */
function splitText(text: string): [string, string] {
  const at = text.lastIndexOf(", ");
  return at < 0 ? ["", text] : [text.slice(0, at), text.slice(at + 2)];
}

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
