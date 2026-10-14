import { addDays, isCalendarDay } from "./calendar";
import { localInputToUtc } from "./window";

/**
 * The instants a run of whole days in `timeZone` covers: from the first moment of `from`
 * up to, and not including, the first moment of the day after `to` (#721).
 *
 * A day in the store's zone is not a day in UTC. The activity filter built its range from
 * UTC midnights, so a New York shop filtering to 25 Sep got 24 Sep 20:00 to 25 Sep 19:59 --
 * that evening's entries missing, and the previous evening's shown under the wrong day.
 *
 * "First moment" rather than midnight: through `localInputToUtc`, a day whose clocks skip
 * midnight starts at the hour they skip to, and a day that repeats an hour is still one day.
 * Dates are `YYYY-MM-DD` days that exist; anything else leaves that end of the range open.
 * "That exist" because `2026-02-31` has the right shape and used to filter to 3 March
 * without saying so (#747).
 */
export function dayRange(
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
): { gte?: Date; lt?: Date } {
  const start = isCalendarDay(from) ? localInputToUtc(`${from}T00:00`, timeZone) : null;
  const end = isCalendarDay(to) ? localInputToUtc(`${addDays(to, 1)}T00:00`, timeZone) : null;
  return {
    ...(start ? { gte: new Date(start) } : {}),
    ...(end ? { lt: new Date(end) } : {}),
  };
}
