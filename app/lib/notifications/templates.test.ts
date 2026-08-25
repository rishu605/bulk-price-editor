/**
 * The rule this module exists to keep: no price value ever reaches an email body.
 *
 * Email is unencrypted in transit, lands in a mailbox the app does not control, gets
 * forwarded, indexed by mail providers and read on shared screens. A merchant's
 * pricing is commercially sensitive and none of it belongs there — counts carry
 * everything an email needs to, and the app is one click away for the specifics.
 *
 * A rule kept by care is a rule that lapses the first time somebody adds a field to a
 * template in a hurry, so it is asserted with a property test over generated counts
 * rather than checked by eye.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { compose, type RunCounts } from "./templates";

const counts = (over: Partial<RunCounts> = {}): RunCounts => ({
  verified: 12,
  skipped: 0,
  clamped: 0,
  failed: 0,
  unverified: 0,
  ...over,
});

describe("compose", () => {
  it("leads with the outcome, not the campaign name, in the subject", () => {
    // A merchant scanning an inbox needs the verdict before the label.
    const email = compose({ kind: "run-completed", campaignName: "Summer", counts: counts() });
    expect(email.subject).toContain("finished");
    expect(email.subject).toContain("12 variants updated");
  });

  it("says a partial run is partial, and how to finish it", () => {
    const email = compose({
      kind: "run-partial",
      campaignName: "Summer",
      counts: counts({ verified: 8, failed: 4 }),
      reasons: ["Shopify rate-limited this write. It will be retried automatically."],
    });

    expect(email.subject).toContain("partially");
    expect(email.text).toContain("Failed: 4");
    expect(email.text).toContain("Resuming");
    expect(email.text).toContain("rate-limited");
  });

  it("omits zero counts rather than listing them", () => {
    // "0 failed, 0 skipped, 0 clamped" is noise that hides the number that matters.
    const email = compose({ kind: "run-completed", campaignName: "Summer", counts: counts() });
    expect(email.text).not.toContain("Failed: 0");
    expect(email.text).not.toContain("Skipped: 0");
  });

  it("explains that a revert recomputes rather than restores", () => {
    // The single most misunderstood thing the app does. A merchant expecting prices
    // to snap back to full will read a correct revert as a bug without this.
    const email = compose({
      kind: "revert-completed",
      campaignName: "Summer",
      counts: counts(),
    });
    expect(email.text).toContain("recomputes");
    expect(email.text).toContain("another campaign still covers");
  });

  it("tells a drift email that the edits were deliberate and untouched", () => {
    const email = compose({ kind: "drift-hold", campaignName: "Summer", driftedCount: 3 });
    expect(email.subject).toContain("changed outside the app");
    expect(email.text).toContain("has not overwritten them");
  });

  it("says plainly when a digest needs nothing from the merchant", () => {
    const quiet = compose({
      kind: "weekly-digest",
      shopName: "DartMode",
      campaignsRun: 2,
      variantsChanged: 40,
      driftOpen: 0,
      partialRuns: 0,
    });
    expect(quiet.text).toContain("Nothing is waiting for you.");
  });
});

describe("no price values in any email body", () => {
  /**
   * Anything that reads as money. Deliberately broad — a decimal, a currency symbol,
   * or a currency code all count as a leak, and being over-strict here costs nothing
   * because legitimate content is counts and prose.
   */
  const MONEY = /[$£€¥]|\b\d+\.\d{2}\b|\b(USD|EUR|GBP|JPY|CAD|AUD)\b/;

  it("holds for every run notification, whatever the counts", () => {
    fc.assert(
      fc.property(
        fc.record({
          verified: fc.nat({ max: 1_000_000 }),
          skipped: fc.nat({ max: 1_000_000 }),
          clamped: fc.nat({ max: 1_000_000 }),
          failed: fc.nat({ max: 1_000_000 }),
          unverified: fc.nat({ max: 1_000_000 }),
        }),
        fc.constantFrom("run-completed", "run-partial", "run-failed", "revert-completed" as const),
        (generated, kind) => {
          const email = compose({
            kind: kind as "run-completed",
            campaignName: "Summer sale",
            counts: generated,
          });
          expect(email.subject).not.toMatch(MONEY);
          expect(email.text).not.toMatch(MONEY);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("holds when a campaign is named after a price", () => {
    // The merchant chose the name; the app still must not be the thing that puts a
    // price in a subject line. Names are echoed, so this documents the one place a
    // money-shaped string can legitimately appear.
    const email = compose({
      kind: "run-completed",
      campaignName: "$5 off everything",
      counts: counts(),
    });
    expect(email.subject).toContain("$5 off everything");
    // Everything the app itself generated is still clean.
    expect(email.text.replace("$5 off everything", "")).not.toMatch(MONEY);
  });

  it("holds for a digest", () => {
    const email = compose({
      kind: "weekly-digest",
      shopName: "DartMode",
      campaignsRun: 9,
      variantsChanged: 123_456,
      driftOpen: 2,
      partialRuns: 1,
    });
    expect(email.text).not.toMatch(MONEY);
  });
});
