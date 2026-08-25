/**
 * Who did this.
 *
 * The audit log is only worth keeping if it can answer "who turned the cost floor
 * off?", and until now every entry was attributed to the shop domain or to the string
 * "system" — which answers nothing on a store where four people have admin access.
 *
 * Staff identity is available without switching the app to online tokens: App Bridge
 * signs every embedded request with a session token whose `sub` claim is the staff
 * user's id, and `authenticate.admin` has already verified it by the time a loader
 * runs. Online tokens would carry a name as well, but they change the OAuth flow and
 * force a reinstall, which is not a trade worth making for a display string.
 *
 * So entries carry a stable per-staff id. It is not a name, and the log says as much
 * rather than implying it is one.
 *
 * Not a `.server` module, deliberately. `describeActor` renders in the browser, and
 * anything under a `.server` name is stripped from the client bundle — it would be
 * `undefined` at render time with nothing at build time to say so. The only server
 * concept here is a type, which is erased anyway.
 */

import type { JwtPayload } from "@shopify/shopify-api";

/** What an unattended action is attributed to. */
export const SCHEDULER_ACTOR = "scheduler";

/**
 * The actor for an admin request.
 *
 * Falls back to the shop domain rather than to null: an action that definitely had a
 * person behind it should not be recorded as if the scheduler did it, even when the
 * token is shaped unexpectedly.
 */
export function actorFor(
  sessionToken: JwtPayload | undefined,
  shopDomain: string,
): string {
  const sub = sessionToken?.sub;
  return typeof sub === "string" && sub.length > 0 ? `staff:${sub}` : shopDomain;
}

/** Renders an actor for display, without pretending an id is a name. */
export function describeActor(actor: string | null): string {
  if (!actor || actor === SCHEDULER_ACTOR || actor === "system") return "Scheduler";
  if (actor === "drift-detector") return "Drift detector";
  if (actor.startsWith("staff:")) return `Staff ${actor.slice("staff:".length)}`;
  return actor;
}
