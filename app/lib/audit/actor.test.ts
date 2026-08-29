/**
 * Who the audit log says did it.
 *
 * The module exists because every entry used to be attributed to the shop domain or to
 * "system", which answers nothing on a store where four people have admin access. Its own
 * comment states the point: *"The audit log is only worth keeping if it can answer 'who
 * turned the cost floor off?'"*
 *
 * `actorFor` could be made to return the shop domain for every request — exactly the state
 * it was written to replace — and all 2,948 tests passed.
 */

import { describe, expect, it } from "vitest";

import { actorFor, describeActor, SCHEDULER_ACTOR } from "./actor";

const token = (sub: unknown) => ({ sub }) as never;

describe("attributing an admin request", () => {
  it("records the staff id from the session token", () => {
    expect(actorFor(token("gid://shopify/StaffMember/42"), "shop.myshopify.com")).toBe(
      "staff:gid://shopify/StaffMember/42",
    );
  });

  it("falls back to the shop domain when the token has no subject", () => {
    // Deliberately not the scheduler. An action that definitely had a person behind it
    // must not be recorded as if nobody did it, even when the token is shaped oddly.
    expect(actorFor(undefined, "shop.myshopify.com")).toBe("shop.myshopify.com");
    expect(actorFor(token(undefined), "shop.myshopify.com")).toBe("shop.myshopify.com");
  });

  it.each([[""], [42], [null], [{}]])(
    "falls back rather than recording %j as a staff id",
    (sub) => {
      expect(actorFor(token(sub), "shop.myshopify.com")).toBe("shop.myshopify.com");
    },
  );

  it("never attributes a person's action to the scheduler", () => {
    // The failure that would matter: an audit entry reading "Scheduler" for something a
    // person did is worse than one reading the shop domain, because it is confidently
    // wrong rather than vague.
    expect(actorFor(token(undefined), "shop.myshopify.com")).not.toBe(SCHEDULER_ACTOR);
  });

  it("prefixes the id, so a staff actor cannot be mistaken for a domain", () => {
    expect(actorFor(token("7"), "shop.myshopify.com").startsWith("staff:")).toBe(true);
  });
});

describe("rendering an actor", () => {
  it("shows an unattended action as the scheduler", () => {
    expect(describeActor(SCHEDULER_ACTOR)).toBe("Scheduler");
  });

  it.each([[null], [""], ["system"]])("shows %j as the scheduler too", (actor) => {
    // "system" is what older entries carry. They still have to render as something a
    // person can read rather than as a raw token from a previous schema.
    expect(describeActor(actor)).toBe("Scheduler");
  });

  it("names the drift detector, which is neither a person nor the scheduler", () => {
    expect(describeActor("drift-detector")).toBe("Drift detector");
  });

  it("renders a staff actor as an id, without pretending it is a name", () => {
    // The module deliberately does not fetch names — that would need online tokens and a
    // reinstall. So the display says "Staff <id>", which is honest about what it knows.
    expect(describeActor("staff:42")).toBe("Staff 42");
  });

  it("keeps the whole id, including one that contains a colon", () => {
    // Shopify staff ids are gids, which are full of colons and slashes. Splitting on the
    // separator rather than trimming the prefix would truncate every real one.
    expect(describeActor("staff:gid://shopify/StaffMember/42")).toBe(
      "Staff gid://shopify/StaffMember/42",
    );
  });

  it("passes an unrecognised actor through rather than hiding it", () => {
    // A shop domain, or something a future release writes. Rendering it as "Scheduler"
    // would attribute a person's action to nobody.
    expect(describeActor("shop.myshopify.com")).toBe("shop.myshopify.com");
  });

  it("round-trips what actorFor produces", () => {
    // The two halves are used by different processes and had no test tying them
    // together, which is how a prefix change breaks display without failing anything.
    expect(describeActor(actorFor(token("99"), "shop.myshopify.com"))).toBe("Staff 99");
  });
});
