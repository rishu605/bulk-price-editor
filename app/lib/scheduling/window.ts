/**
 * Deciding what a scheduled campaign owes right now.
 *
 * Pure: it takes a schedule, a status and a clock reading, and returns the
 * transition due. No database, no `Date.now()` inside — so every timing rule below
 * is testable without waiting for real time to pass.
 *
 * The rule that makes the whole thing self-healing: **due means `at <= now`, never
 * `at === now`**. A tick that is missed — a deploy, a restart, a slow queue — is
 * caught by the next one, because the campaign is still past its start time.
 * Equality checks silently drop any campaign whose moment fell in the gap.
 */

export type Schedule =
  | { kind: "manual" }
  | {
      kind: "window";
      /** ISO 8601, always UTC. The UI renders it in the store's zone. */
      startAt: string;
      /** Absent means "runs until reverted by hand". */
      endAt?: string;
      /**
       * Minutes before `endAt` to begin reverting. A deep bulk queue can take
       * minutes, and starting exactly at the end leaves sale prices live past the
       * window the merchant advertised.
       */
      revertBufferMinutes?: number;
    };

export const DEFAULT_REVERT_BUFFER_MINUTES = 5;

export type Transition = "apply" | "revert";

/** Campaign statuses this module reasons about. */
export type SchedulableStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "APPLYING"
  | "ACTIVE"
  | "REVERTING"
  | "COMPLETED"
  | "PARTIAL"
  | "HELD"
  | "CANCELLED";

export interface ScheduleState {
  schedule: Schedule;
  status: SchedulableStatus;
}

export function parseSchedule(raw: unknown): Schedule {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.kind !== "window") return { kind: "manual" };

  const startAt = typeof value.startAt === "string" ? value.startAt : null;
  // A window with no valid start cannot be acted on; treating it as manual is
  // safer than inventing a start time and applying prices unexpectedly.
  if (!startAt || Number.isNaN(Date.parse(startAt))) return { kind: "manual" };

  const endAt =
    typeof value.endAt === "string" && !Number.isNaN(Date.parse(value.endAt))
      ? value.endAt
      : undefined;

  const buffer = Number(value.revertBufferMinutes);

  return {
    kind: "window",
    startAt,
    endAt,
    revertBufferMinutes: Number.isFinite(buffer) && buffer >= 0
      ? buffer
      : DEFAULT_REVERT_BUFFER_MINUTES,
  };
}

/**
 * The transition due for a campaign, or `null` if nothing is owed.
 *
 * Revert is checked before apply. A campaign whose whole window has already passed
 * — created late, or resumed after a long outage — must revert rather than apply,
 * or it would put a finished sale live.
 */
export function dueTransition(state: ScheduleState, now: Date): Transition | null {
  const { schedule, status } = state;
  if (schedule.kind !== "window") return null;

  const start = Date.parse(schedule.startAt);
  const end = schedule.endAt ? Date.parse(schedule.endAt) : null;
  const revertAt = end === null ? null : end - effectiveBufferMs(schedule);
  const millis = now.getTime();

  const pastRevert = revertAt !== null && millis >= revertAt;

  if (pastRevert) {
    // Only something currently live needs reverting. A campaign that never applied
    // has nothing to undo, and re-reverting a completed one would be a no-op run.
    return status === "ACTIVE" || status === "PARTIAL" ? "revert" : null;
  }

  if (millis >= start) {
    return status === "SCHEDULED" ? "apply" : null;
  }

  return null;
}

/**
 * The revert buffer actually used, capped at half the window.
 *
 * A buffer longer than the window would put the revert moment before the start,
 * so the campaign would never apply -- it would go straight from scheduled to
 * nothing, with no error and no prices changed. Capping keeps a short window
 * usable; `scheduleWarnings` tells the merchant when the cap kicked in.
 */
export function effectiveBufferMs(schedule: Extract<Schedule, { kind: "window" }>): number {
  const requested = (schedule.revertBufferMinutes ?? DEFAULT_REVERT_BUFFER_MINUTES) * 60_000;
  if (!schedule.endAt) return requested;

  const duration = Date.parse(schedule.endAt) - Date.parse(schedule.startAt);
  if (!Number.isFinite(duration) || duration <= 0) return 0;

  return Math.min(requested, Math.floor(duration / 2));
}

/** Problems worth telling the merchant about before they schedule something. */
export function scheduleWarnings(schedule: Schedule): string[] {
  if (schedule.kind !== "window") return [];

  const warnings: string[] = [];
  const start = Date.parse(schedule.startAt);

  if (schedule.endAt) {
    const end = Date.parse(schedule.endAt);

    if (end <= start) {
      warnings.push("The end is not after the start, so this campaign will never apply.");
    } else {
      const requested =
        (schedule.revertBufferMinutes ?? DEFAULT_REVERT_BUFFER_MINUTES) * 60_000;
      const duration = end - start;

      // Warn exactly when capping kicks in, which is when the buffer would eat more
      // than half the window -- not only when it exceeds the whole window. A
      // 60-second buffer on a 65-second window leaves five seconds to apply, which
      // is just as broken and would otherwise pass silently.
      if (requested > duration / 2) {
        warnings.push(
          `The revert buffer is longer than half the window, so there would be almost ` +
            `no time to apply prices before reverting them. It has been capped at ` +
            `${Math.max(1, Math.round(duration / 2 / 60_000))} minute(s).`,
        );
      }
      if (duration < 5 * 60_000) {
        warnings.push(
          "This window is under five minutes. The scheduler checks every 30 seconds, " +
            "and a busy bulk queue can take longer than that to apply prices.",
        );
      }
    }
  }

  return warnings;
}

/** True when the window has closed, whether or not anything was applied. */
export function windowClosed(schedule: Schedule, now: Date): boolean {
  if (schedule.kind !== "window" || !schedule.endAt) return false;
  return now.getTime() >= Date.parse(schedule.endAt);
}

/**
 * Human summary of a schedule, rendered in the store's zone.
 *
 * The zone is always shown. A merchant reading "starts at 09:00" needs to know
 * whose nine o'clock, and a campaign that goes live at the wrong hour is a real
 * cost.
 */
export function describeSchedule(schedule: Schedule, timeZone: string): string {
  if (schedule.kind !== "window") return "Runs when you apply it by hand.";

  const format = (iso: string) =>
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));

  const start = `Starts ${format(schedule.startAt)}`;
  if (!schedule.endAt) return `${start} (${timeZone}). Runs until you revert it.`;

  const buffer = schedule.revertBufferMinutes ?? DEFAULT_REVERT_BUFFER_MINUTES;
  return (
    `${start}, reverts ${format(schedule.endAt)} (${timeZone}). ` +
    `Reverting begins ${buffer} minutes early so prices are back before the window closes.`
  );
}

/**
 * Converts a datetime-local value, which carries no zone, into UTC for storage.
 *
 * The browser field gives "2026-08-20T09:00" meaning nine o'clock in the store's
 * zone, not the viewer's and not UTC. Reading it with `new Date()` would silently
 * use whatever zone the merchant's laptop happens to be in.
 */
export function localInputToUtc(value: string, timeZone: string): string | null {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];

  // Start from the naive UTC reading, then correct by the zone's offset at that
  // instant. Doing it this way keeps DST correct: the offset is looked up for the
  // date in question rather than assumed constant.
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const offset = zoneOffsetMs(new Date(naive), timeZone);
  return new Date(naive - offset).toISOString();
}

/** A zone's UTC offset in milliseconds at a given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );

  return asUtc - instant.getTime();
}

/** Formats a UTC instant back into a datetime-local value in the store's zone. */
export function utcToLocalInput(iso: string | undefined, timeZone: string): string {
  if (!iso) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // en-CA gives ISO-ish parts; hour can come back as "24" at midnight.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}
