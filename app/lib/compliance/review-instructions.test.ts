/**
 * The testing instructions App Review reads, held to what the review needs (#1125).
 *
 * The version in the Partner Dashboard told the reviewer to open a campaign called "Sale",
 * which existed only on our store, and never mentioned email -- the flow the reviewer then
 * tested, and failed (2.1.4, with 4.5.4 and 4.5.5 flagged beside it). The copy lives in
 * `docs/app-store-listing.md` and is pasted from there, so this is where it is checked.
 *
 * Email is not offered while production cannot send it (#1118), so the instructions say so
 * and send the reviewer nowhere near it.
 */

import { describe, expect, it } from "vitest";

import { NOTIFICATION_CHOICES } from "../notifications/choices";
import { rawSource } from "../testing/source";

const listing = rawSource("docs/app-store-listing.md");
const section = listing.split("## Testing instructions for App Review")[1] ?? "";
const pasted = /```text\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";

describe("the App Review testing instructions", () => {
  it("are there to paste, as one block", () => {
    expect(pasted.length, "no ```text block under the heading").toBeGreaterThan(500);
  });

  it("fit the Partner Dashboard's 2,800-character field", () => {
    expect(pasted.length).toBeLessThanOrEqual(2_800);
  });

  it("say no credentials are needed, and why (4.5.4, 4.5.5)", () => {
    expect(pasted).toContain("No credentials are needed");
    expect(pasted).toContain("inside the Shopify admin");
    expect(pasted).toContain("test charge");
  });

  it("say email is not part of this version, and send the reviewer to no email setting (2.1.4, #1118)", () => {
    expect(pasted).toContain("Email notifications are not part of this version");
    for (const gone of ["Settings → Notifications", "Send test email", "has been reverted", "Emailed"]) {
      expect(pasted, gone).not.toContain(gone);
    }
    for (const label of NOTIFICATION_CHOICES.map((choice) => choice.label)) expect(pasted, label).not.toContain(label);
  });

  it("still walk apply and revert, and where to see what each did", () => {
    for (const step of ["Apply to storefront", "Revert", "Runs tab", "Ledger tab"]) expect(pasted, step).toContain(step);
  });

  it("name nothing that only exists on our own stores", () => {
    // A reviewer installs on their own development store.
    expect(pasted).not.toMatch(/open "Sale"|boltify|dartmode|anchor-perf/i);
  });
});
