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
    // Explicit styles rather than the default, which spells the time out to the second.
    // A column of "27/08/2026, 12:40:38" is asking the reader to skip two characters on
    // every row to reach a distinction no merchant is making — nothing in this app
    // happens on a schedule finer than a minute.
    return new Date(value).toLocaleString(LOCALE, {
      timeZone,
      dateStyle: "short",
      timeStyle: "short",
    });
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

/**
 * How long ago something happened, in words.
 *
 * ## Why a `now` is passed in rather than read
 *
 * Calling `Date.now()` inside this function would compute the string twice — once on the
 * server rendering the HTML, once in the browser hydrating it — at two different
 * instants. Most of the time that agrees; around a boundary it does not, and React
 * patches over a difference it should never have been shown. Taking `now` from the
 * loader makes both renders read the same clock, which also gives the phrase an honest
 * meaning: *as of when this page was loaded*.
 *
 * ## Why relative at all
 *
 * A dashboard's activity list is five timestamps stacked vertically, and rendered
 * absolutely they are five nearly identical strings — "27/08/2026, 12:40:38" five times.
 * The reader has to diff them character by character to learn the only thing they wanted
 * to know, which is whether this happened recently. Relative time answers that in a
 * glance and stops the column being noise.
 *
 * Anything older than a week falls back to a date, because "47 days ago" is a subtraction
 * the reader now has to undo to place it against anything else they know.
 */
export function formatAgo(value: Date | string, now: Date | string, timeZone: string): string {
  const then = new Date(value).getTime();
  const at = new Date(now).getTime();
  if (Number.isNaN(then) || Number.isNaN(at)) return String(value);

  const seconds = Math.round((at - then) / 1000);
  const future = seconds < 0;
  const size = Math.abs(seconds);

  // Cast rather than pluralised by hand at four call sites: the unit is singular when
  // the count is one, and "1 minutes ago" is the kind of detail that makes a UI look
  // unattended.
  const phrase = (count: number, unit: string) =>
    `${count} ${unit}${count === 1 ? "" : "s"}`;

  const relative = (body: string) => (future ? `in ${body}` : `${body} ago`);

  if (size < 45) return future ? "in a moment" : "just now";
  if (size < 3600) return relative(phrase(Math.round(size / 60), "minute"));
  if (size < 86_400) return relative(phrase(Math.round(size / 3600), "hour"));
  if (size < 604_800) return relative(phrase(Math.round(size / 86_400), "day"));
  return formatDay(value, timeZone);
}
