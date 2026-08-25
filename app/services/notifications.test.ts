/**
 * Preferences, and the defaults that decide whether anyone reads these emails.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, parsePreferences, wants } from "./notifications.server";

describe("parsePreferences", () => {
  it("fills absent fields with defaults rather than turning everything off", () => {
    // A shop that saved preferences before a new kind existed must keep hearing about
    // the ones it already opted into.
    expect(parsePreferences({})).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it("treats an address without an @ as no address", () => {
    // Better to send nothing than to hand a mail provider something that will bounce
    // on every run for weeks.
    expect(parsePreferences({ email: "not-an-email" }).email).toBeNull();
    expect(parsePreferences({ email: "  ops@shop.com " }).email).toBe("ops@shop.com");
  });

  it("keeps explicit false rather than falling back to a true default", () => {
    expect(parsePreferences({ onDrift: false }).onDrift).toBe(false);
  });

  it("defaults success emails off and decision emails on", () => {
    // A merchant emailed about every successful run stops reading the emails, and
    // then misses the partial one that mattered.
    expect(DEFAULT_PREFERENCES.onCompletion).toBe(false);
    expect(DEFAULT_PREFERENCES.onPartialOrFailure).toBe(true);
    expect(DEFAULT_PREFERENCES.onDrift).toBe(true);
  });
});

describe("wants", () => {
  const prefs = { ...DEFAULT_PREFERENCES, email: "ops@shop.com" };
  const run = (kind: "run-completed" | "run-partial" | "run-failed" | "revert-completed") =>
    ({ kind, campaignName: "Summer", counts: { verified: 1, skipped: 0, clamped: 0, failed: 0, unverified: 0 } }) as const;

  it("routes partial and failed through the same preference", () => {
    // They are the same question to a merchant: something needs me.
    expect(wants({ ...prefs, onPartialOrFailure: false }, run("run-partial"))).toBe(false);
    expect(wants({ ...prefs, onPartialOrFailure: false }, run("run-failed"))).toBe(false);
    expect(wants({ ...prefs, onPartialOrFailure: true }, run("run-failed"))).toBe(true);
  });

  it("does not send completion emails to a shop that only asked about problems", () => {
    expect(wants(prefs, run("run-completed"))).toBe(false);
  });

  it("honours the revert and drift preferences separately", () => {
    expect(wants({ ...prefs, onRevert: false }, run("revert-completed"))).toBe(false);
    expect(
      wants({ ...prefs, onDrift: false }, { kind: "drift-hold", campaignName: "S", driftedCount: 2 }),
    ).toBe(false);
  });
});
