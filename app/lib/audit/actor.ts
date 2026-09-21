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

/**
 * The last few characters of an id, which is as much of one as a person can hold.
 *
 * Staff ids arrive either as a bare numeric id or as a gid full of slashes, so the last
 * path segment comes off first. Four characters, because that is the length every bank
 * and airline has settled on for "enough to tell yours from somebody else's".
 */
function shortId(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.length <= 4 ? last : last.slice(-4);
}

/**
 * Renders an actor for display, without pretending an id is a name.
 *
 * ## Why not the name
 *
 * Because the app cannot have it. Names come from `staffMember`, which needs
 * `read_users`, and this app asks for `write_products`, `read_markets` and
 * `write_markets`. Adding a scope forces a reinstall, and the trade — every merchant
 * re-consenting — is not worth a display string. `actorFor` above says the same thing
 * about online tokens.
 *
 * ## Why not "a staff member" either
 *
 * That was the other option and it loses the only thing this column is for. The log
 * exists to answer "who turned the cost floor off?" on a store where four people have
 * admin access, and a feed that renders all four identically cannot. The **Who** filter
 * on `/app/activity` would go further and offer four options with the same label.
 *
 * So: short, stable, and visibly an id rather than a name. "Staff 7946" instead of
 * "Staff 91614707946" — eleven digits of noise on the first screen after installing,
 * where the only question anybody asks of it is "was that me or somebody else".
 *
 * Nothing is lost. The filter's *value* is still the whole id, so filtering stays exact,
 * and `activityCsv` exports the raw `staff:<id>` rather than this, so the export a
 * support case attaches is still unambiguous.
 */
export function describeActor(actor: string | null): string {
  if (!actor || actor === SCHEDULER_ACTOR || actor === "system") return "Scheduler";
  if (actor === "drift-detector") return "Drift detector";
  if (actor.startsWith("staff:")) return `Staff ${shortId(actor.slice("staff:".length))}`;
  return actor;
}
