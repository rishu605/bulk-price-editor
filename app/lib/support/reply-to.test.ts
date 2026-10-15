/**
 * Contact support names the actual problem with a reply address (#759).
 *
 * `not-an-email` was answered "We need an address to reply to." -- which reads as though
 * the field were empty, to a merchant looking at the address they typed into it.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { replyToProblem } from "./reply-to";

describe("a reply address", () => {
  it("is accepted when it looks like one", () => {
    expect(replyToProblem("ops@dartmode-labs.com")).toBeNull();
    expect(replyToProblem("  owner+anchor@shop.co.uk ")).toBeNull();
  });

  it("asks for one when there is none", () => {
    expect(replyToProblem("")).toBe("Add the email address we should reply to, then send again.");
    expect(replyToProblem("   ")).toBe("Add the email address we should reply to, then send again.");
  });

  it("says an address that is not one is not one, quoting it, rather than that it is missing", () => {
    const said = replyToProblem("not-an-email");

    expect(said).toBe('"not-an-email" is not an email address. Check it reads like you@yourstore.com, then send again.');
    expect(said).not.toContain("We need an address");
  });

  it("catches the near misses an @ alone let through", () => {
    for (const value of ["owner@", "@shop.com", "owner@shop", "owner @shop.com"]) {
      expect(replyToProblem(value), value).toContain("is not an email address");
    }
  });

  it("is what Contact support checks before sending", () => {
    const route = sourceOf("app/routes/app.support.tsx");

    expect(route).toContain("replyToProblem(replyTo)");
    expect(route).not.toContain("We need an address to reply to");
  });
});
