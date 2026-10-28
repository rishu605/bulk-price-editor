/**
 * What happened to each email, said back to the merchant (#1121, #1123).
 *
 * App Review reverted a campaign to trigger its email, none came, and nothing in the app
 * could say why. These are the sentences that now can.
 */

import { describe, expect, it } from "vitest";

import { formatWhen } from "../format/display";
import {
  deliveryEntry,
  lastEmailLines,
  readDelivery,
  runEmailLine,
  savedAddressLine,
  type Delivery,
  type DeliveryOutcome,
} from "./delivery";
import type { RunNotification } from "./templates";

const AT = "2026-10-29T10:42:00.000Z";

const reverted: RunNotification = {
  kind: "revert-completed",
  campaignId: "c1",
  campaignName: "Summer sale",
  counts: { verified: 3, skipped: 0, clamped: 0, failed: 0, unverified: 0 },
};

const delivery = (outcome: DeliveryOutcome, over: Partial<Delivery> = {}): Delivery => ({
  kind: "revert-completed",
  outcome,
  campaign: "Summer sale",
  to: outcome === "no-recipient" || outcome === "unconfigured" ? null : "ops@shop.com",
  status: null,
  runId: "run_1",
  at: AT,
  ...over,
});

describe("the stored entry", () => {
  it("round-trips through the audit log", () => {
    const after = deliveryEntry(reverted, "failed", { to: "ops@shop.com", status: 422, runId: "run_1" });
    expect(readDelivery(after, AT)).toEqual(delivery("failed", { status: 422 }));
  });

  it("leaves out what is absent, so Activity does not list empty fields", () => {
    expect(deliveryEntry(reverted, "unconfigured", {})).toEqual({
      kind: "revert-completed",
      outcome: "unconfigured",
      campaign: "Summer sale",
    });
  });

  it("carries no price, whatever the notification held", () => {
    const after = JSON.stringify(deliveryEntry(reverted, "sent", { to: "ops@shop.com" }));
    expect(after).not.toMatch(/\d+\.\d{2}/);
    expect(after).not.toContain("counts");
  });

  it("ignores entries it did not write", () => {
    expect(readDelivery(null, AT)).toBeNull();
    expect(readDelivery({ pending: 4 }, AT)).toBeNull();
    expect(readDelivery({ kind: "revert-completed", outcome: "lost" }, AT)).toBeNull();
  });
});

describe("Settings' account of the last email", () => {
  const when = formatWhen(AT, "UTC");

  it("says when nothing has been sent", () => {
    expect(lastEmailLines([], "UTC")).toEqual({ sent: "No email has been sent yet.", problem: null });
  });

  it("names the last email sent, where it went, and when, in the shop's time", () => {
    const { sent } = lastEmailLines([delivery("sent")], "UTC");
    expect(sent).toBe(`Last email: “Summer sale” was reverted, sent to ops@shop.com on ${when}.`);
  });

  it("says why the newest email that should have gone did not", () => {
    const lines = lastEmailLines([delivery("unconfigured"), delivery("sent", { at: "2026-10-01T09:00:00.000Z" })], "UTC");
    expect(lines.sent).toContain("sent to ops@shop.com");
    expect(lines.problem).toBe(`Not sent: “Summer sale” was reverted, on ${when}, because Anchor couldn't send email at the time.`);
  });

  it("does not call a muted email a problem: switching one off is the merchant's choice", () => {
    expect(lastEmailLines([delivery("muted"), delivery("sent")], "UTC").problem).toBeNull();
  });

  it("does not repeat a problem older than the last email that went out", () => {
    expect(lastEmailLines([delivery("sent"), delivery("failed", { status: 422 })], "UTC").problem).toBeNull();
  });

  it("gives every reason its own words", () => {
    const reasonFor = (outcome: DeliveryOutcome, over: Partial<Delivery> = {}) =>
      lastEmailLines([delivery(outcome, over)], "UTC").problem;
    expect(reasonFor("no-recipient")).toContain("no address was saved");
    expect(reasonFor("failed", { status: 422 })).toContain("the mail provider refused it (status 422)");
    expect(reasonFor("unconfigured")).toContain("Anchor couldn't send email");
  });

  it("reads the address back as stored, or says there is none", () => {
    expect(savedAddressLine("ops@shop.com")).toBe("Emails go to ops@shop.com.");
    expect(savedAddressLine(null)).toBe("No address saved, so no emails are sent.");
  });
});

describe("a run's email, in its row", () => {
  it("is blank for a run with no record, rather than a guess", () => {
    expect(runEmailLine(undefined)).toBeNull();
  });

  it("names where a sent email went", () => {
    expect(runEmailLine(delivery("sent"))).toEqual({ text: "Emailed ops@shop.com", toSettings: false });
  });

  it("names the checkbox that muted it, and links to Settings where it can be changed", () => {
    expect(runEmailLine(delivery("muted"))).toEqual({
      text: "No email: “A campaign was reverted” is switched off",
      toSettings: true,
    });
    expect(runEmailLine(delivery("muted", { kind: "run-completed" }))?.text).toContain("“A run finished cleanly”");
    expect(runEmailLine(delivery("no-recipient"))).toEqual({ text: "No email: no address was saved", toSettings: true });
  });

  it("does not send the merchant to Settings for what Settings cannot fix", () => {
    expect(runEmailLine(delivery("unconfigured"))?.toSettings).toBe(false);
    expect(runEmailLine(delivery("failed", { status: 422 }))).toEqual({
      text: "Not delivered: the mail provider refused it (status 422)",
      toSettings: false,
    });
  });
});
