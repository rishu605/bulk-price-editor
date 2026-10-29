/**
 * The notification address is refused by name, not thrown away under "Settings saved."
 * (#1120).
 *
 * "ops" was saved as no address while the field went on showing "ops", and two addresses
 * were saved whole and refused by the mail provider on every send.
 */

import { describe, expect, it } from "vitest";

import { notificationEmailFrom, notificationInputProblems } from "./notification-input";

const problemsFor = (email: string | null) =>
  notificationInputProblems((name) => (name === "email" ? email : null));

describe("notificationEmailFrom", () => {
  it("reads blank as notifications off, not as a problem", () => {
    expect(notificationEmailFrom("")).toBeNull();
    expect(notificationEmailFrom("   ")).toBeNull();
    expect(notificationEmailFrom(null)).toBeNull();
  });

  it("keeps one address, trimmed", () => {
    expect(notificationEmailFrom("  ops@shop.com ")).toBe("ops@shop.com");
    expect(notificationEmailFrom("first.last+anchor@mail.shop.co.uk")).toBe("first.last+anchor@mail.shop.co.uk");
  });

  it("refuses anything that is not one address", () => {
    for (const typed of [
      "ops",
      "ops.yourshop.com",
      "ops@",
      "@shop.com",
      "ops@shop",
      "ops @shop.com",
      "a@shop.com, b@shop.com",
      "a@shop.com;b@shop.com",
      "a@shop.com b@shop.com",
      "Ops <ops@shop.com>",
    ]) {
      expect(notificationEmailFrom(typed), typed).toBeUndefined();
    }
  });
});

describe("notificationInputProblems", () => {
  it("has nothing to say about a valid address, a blank one, or a form without the field", () => {
    expect(problemsFor("ops@shop.com")).toEqual([]);
    expect(problemsFor("")).toEqual([]);
    expect(problemsFor(null)).toEqual([]);
  });

  it("names the field, what was typed, and what to enter instead", () => {
    const [problem] = problemsFor("ops");
    expect(problem?.field).toBe("email");
    expect(problem?.message).toContain("Send to");
    expect(problem?.message).toContain("“ops”");
    expect(problem?.message).toContain("ops@yourshop.com");
    expect(problem?.message).toContain("blank");
  });

  it("says one address when several were typed, rather than calling them malformed", () => {
    const [problem] = problemsFor("a@shop.com, b@shop.com");
    expect(problem?.message).toContain("one address");
    expect(problem?.message).toContain("more than one");
  });
});
