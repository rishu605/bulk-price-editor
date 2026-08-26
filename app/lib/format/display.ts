/**
 * Formatting numbers and times for a merchant, deterministically.
 *
 * `toLocaleString()` with no arguments reads the *environment's* locale and timezone.
 * That is two bugs wearing one coat:
 *
 * - **Numbers.** It was found rendering 120,000 as "1,20,000" — lakh grouping, because
 *   the machine was set to en-IN. On a server it is whatever the container happens to be,
 *   and since these strings are server-rendered and then hydrated in the merchant's
 *   browser, the two can disagree and React has to patch over the difference.
 *
 * - **Times.** Worse for a scheduling product. A timestamp formatted without a zone is
 *   the *server's* zone, which on a hosted deployment is UTC, presented as though it were
 *   the merchant's. "Reverts at 3:58 PM" being several hours out is not a display
 *   preference; it is the merchant mistiming a sale.
 *
 * So both take their locale explicitly, and times take the shop's zone — which the app
 * already stores, and which `ActivityTable` was already passing correctly. This module is
 * that one correct implementation, moved somewhere the rest of the app can reach.
 */

/**
 * The locale for grouping digits.
 *
 * Fixed rather than negotiated: the app's copy is English, and a number grouped one way
 * on the server and another in the browser is a hydration mismatch. When merchant-locale
 * support arrives this becomes a parameter, and every call site already goes through here.
 */
const LOCALE = "en-GB";

/** A count, grouped the same way everywhere. */
export function formatCount(value: number): string {
  return value.toLocaleString(LOCALE);
}

/**
 * A timestamp in the shop's own timezone.
 *
 * A bad zone string throws a `RangeError`, which would take a whole page down over a
 * display preference — so the raw value is returned instead. Showing an ISO string is
 * ugly; showing an error page because a shop has an unusual timezone is worse.
 */
export function formatWhen(value: Date | string, timeZone: string): string {
  try {
    return new Date(value).toLocaleString(LOCALE, { timeZone });
  } catch {
    return String(value);
  }
}

/** A date without the time, same rules. */
export function formatDay(value: Date | string, timeZone: string): string {
  try {
    return new Date(value).toLocaleDateString(LOCALE, { timeZone });
  } catch {
    return String(value);
  }
}
