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
    // The module deliberately does not fetch names — that would need `read_users` and a
    // reinstall. So the display says "Staff <id>", which is honest about what it knows.
    expect(describeActor("staff:42")).toBe("Staff 42");
  });

  it("shortens a real id to something a person can hold", () => {
    // Live on the dashboard this read "Staff 91614707946" — eleven digits of noise on
    // the first screen after installing, where the only question asked of it is "was
    // that me or somebody else".
    expect(describeActor("staff:91614707946")).toBe("Staff 7946");
  });

  it("still tells two people apart, which is the whole job of this column", () => {
    // The alternative was "A staff member" for everybody, which renders the log unable
    // to answer the question it exists for, and gives the Who filter four identical
    // options on a shop with four admins.
    expect(describeActor("staff:91614707946")).not.toBe(describeActor("staff:91614701234"));
  });

  it("takes the id out of a gid rather than the whole path", () => {
    // Shopify staff ids arrive either bare or as a gid full of slashes. Shortening the
    // raw string would leave "Staff r/42" — the tail of the path, not the id.
    expect(describeActor("staff:gid://shopify/StaffMember/91614707946")).toBe("Staff 7946");
  });

  it("leaves a short id alone rather than padding or trimming it", () => {
    expect(describeActor("staff:7")).toBe("Staff 7");
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
