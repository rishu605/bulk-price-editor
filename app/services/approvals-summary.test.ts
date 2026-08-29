import { describe, expect, it } from "vitest";

import { approvalSummary } from "./approvals.server";

/**
 * The campaign page reads `who` and `note` off one flat object. The union it comes from
 * makes "declined by nobody" unrepresentable; flattening it is where that guarantee can
 * be dropped, so each branch is checked for the field it is the only source of.
 */
describe("approvalSummary", () => {
  it("says nobody signed off when approvals are switched off", () => {
    expect(approvalSummary({ required: false })).toEqual({
      required: false,
      state: "none",
      who: null,
      note: null,
    });
  });

  it("names the person waiting on, the person who approved, and the person who declined", () => {
    const at = new Date("2026-08-29T10:00:00Z");

    expect(
      approvalSummary({ required: true, state: "pending", requestedBy: "ada", requestedAt: at, variants: 9 }),
    ).toMatchObject({ state: "pending", who: "ada", note: null });

    expect(
      approvalSummary({ required: true, state: "approved", approvedBy: "grace", approvedAt: at }),
    ).toMatchObject({ state: "approved", who: "grace", note: null });

    expect(
      approvalSummary({ required: true, state: "declined", declinedBy: "alan", declinedAt: at, note: "too broad" }),
    ).toMatchObject({ state: "declined", who: "alan", note: "too broad" });
  });

  it("carries the reason only from the branch that has one", () => {
    // An approved campaign has no note field at all, and a summary that invented one --
    // or carried the previous decline's -- would put a rejection reason on the page of a
    // campaign that was approved.
    expect(
      approvalSummary({ required: true, state: "approved", approvedBy: "grace", approvedAt: new Date(0) }).note,
    ).toBeNull();
  });
});
