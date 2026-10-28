/**
 * The testing instructions App Review reads, held to what the review needs (#1125).
 *
 * The version in the Partner Dashboard told the reviewer to open a campaign called "Sale",
 * which existed only on our store, and never mentioned email -- the flow the reviewer then
 * tested, and failed (2.1.4, with 4.5.4 and 4.5.5 flagged beside it). The copy lives in
 * `docs/app-store-listing.md` and is pasted from there, so this is where it is checked.
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

  it("walk the email flow the review failed on, from saving an address to the revert email (2.1.4)", () => {
    for (const step of ["Settings → Notifications", "Send test email", "Revert", "has been reverted", "Emailed"]) {
      expect(pasted, step).toContain(step);
    }
  });

  it("name the notifications that are on by default in the words Settings uses", () => {
    expect(pasted).toContain(`"${NOTIFICATION_CHOICES.find((choice) => choice.key === "onCompletion")!.label}" is off by default`);
  });

  it("name nothing that only exists on our own stores", () => {
    // A reviewer installs on their own development store.
    expect(pasted).not.toMatch(/open "Sale"|boltify|dartmode|anchor-perf/i);
  });
});
