/**
 * Which audit entries are the app talking to itself.
 *
 * The dashboard's Recent activity feed showed whatever the log's last five rows were, and
 * on a quiet shop that is the scheduler's own housekeeping. Live on `dartmode-labs` it
 * read:
 *
 *     Mirror audited   Scheduler · 17 hours ago
 *     Mirror audit     Scheduler · 17 hours ago
 *     Market added ×3  Scheduler · 1 day ago
 *
 * Two entries a merchant cannot tell apart, both naming an internal concept, on the first
 * screen after installing. The activity *log* is a genuine differentiator — no competitor
 * has one — and this is not the half of it worth leading with.
 *
 * ## Why a list of what to hide rather than a list of what to show
 *
 * The same argument `describeAction` makes about not being a lookup table, pointed the
 * other way. An allow-list goes stale silently in the direction that costs most: a new
 * merchant-facing action would simply never appear on Home, and nobody would notice
 * because nothing is missing from any page. A deny-list goes stale in the direction that
 * costs least — a new *internal* namespace leaks onto the dashboard, which is visible the
 * first time anybody looks and takes one line to fix.
 *
 * Nothing is hidden from `/app/activity`, which remains complete. This decides what leads.
 */

/**
 * Namespaces written by the app about its own upkeep.
 *
 * `mirror` is the catalogue mirror auditing itself against Shopify. A merchant has no
 * decision to make about it; when it finds something they can act on, that surfaces as
 * drift, which has its own namespace and its own queue.
 */
const HOUSEKEEPING = ["mirror"];

/** True when this entry is the app talking to itself rather than to the merchant. */
export function isHousekeeping(action: string): boolean {
  return HOUSEKEEPING.includes(action.split(".")[0]);
}

/** The entries worth putting on the dashboard, newest first, at most `limit`. */
export function merchantFacing<T extends { action: string }>(entries: T[], limit: number): T[] {
  return entries.filter((entry) => !isHousekeeping(entry.action)).slice(0, limit);
}
