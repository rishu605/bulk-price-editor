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
    const email = compose({ kind: "run-completed", campaignId: "c1", campaignName: "Summer", counts: counts() });
    expect(email.subject).toContain("finished");
    expect(email.subject).toContain("12 variants updated");
  });

  it("counts unverified rows as needing attention, not only failed ones (#710)", () => {
    const email = compose({
      kind: "run-partial",
      campaignId: "c1",
      campaignName: "Summer",
      counts: counts({ failed: 0, unverified: 12 }),
    });
    expect(email.subject).toBe('"Summer" finished partially — 12 rows need attention');
  });

  it("says a revert that left prices on sale is a partial revert, with its reasons (#710)", () => {
    const email = compose({
      kind: "run-partial",
      revert: true,
      campaignId: "c1",
      campaignName: "Summer",
      counts: counts({ failed: 300 }),
      reasons: ["Shopify refused 300 prices."],
    });
    expect(email.subject).toBe('"Summer" finished reverting partially — 300 rows need attention');
    expect(email.text).toContain("parts of the sale may still be live");
    expect(email.text).toContain("Shopify refused 300 prices.");
    expect(email.text).not.toContain("has been reverted.");
  });

  it("says a revert that stopped could not finish reverting (#710)", () => {
    const email = compose({ kind: "run-failed", revert: true, campaignId: "c1", campaignName: "Summer", counts: counts() });
    expect(email.subject).toBe('"Summer" could not finish reverting');
  });

  it("says a scheduled start that was refused never started, wrote nothing, and won't be retried (#975)", () => {
    const email = compose({
      kind: "run-failed",
      notStarted: true,
      campaignId: "c1",
      campaignName: "Summer",
      counts: counts(),
      reasons: ["This campaign's segment was deleted, so it has no products to price."],
    });
    expect(email.subject).toBe('"Summer" did not start on schedule');
    expect(email.text).toMatch(/Nothing was written to your storefront/);
    expect(email.text).toContain("segment was deleted");
    expect(email.text).toMatch(/will not try this start again/);
    // Not the stopped-part-way wording: there is nothing to resume.
    expect(email.text).not.toMatch(/resum/i);
    expect(email.text).not.toMatch(/Variants updated and verified/);
  });

  it("says a sale still applying at its end is ending late, why, and that it reverts when the apply finishes (#829)", () => {
    const email = compose({ kind: "run-failed", endingLate: true, campaignId: "c1", campaignName: "Summer", counts: counts() });
    expect(email.subject).toBe('"Summer" is ending late');
    expect(email.text).toMatch(/still applying its prices, and its revert was due to begin/);
    expect(email.text).toMatch(/the revert begins as soon as the apply finishes/);
    expect(email.text).toMatch(/stay on your storefront, past its end/);
    expect(email.text).toMatch(/you will not get another email about this end/);
    // Nothing failed and nothing is to be resumed: not the stopped-part-way wording.
    expect(email.subject).not.toMatch(/could not/);
    expect(email.text).not.toMatch(/resum|Variants updated and verified/i);
    expect(email.text).not.toMatch(/[$£€¥]|\b\d+\.\d{2}\b/);
  });

  it("says a partial run is partial, and how to finish it", () => {
    const email = compose({
      kind: "run-partial",
      campaignId: "c1",
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
    const email = compose({ kind: "run-completed", campaignId: "c1", campaignName: "Summer", counts: counts() });
    expect(email.text).not.toContain("Failed: 0");
    expect(email.text).not.toContain("Skipped: 0");
  });

  it("explains that a revert recomputes rather than restores", () => {
    // The single most misunderstood thing the app does. A merchant expecting prices
    // to snap back to full will read a correct revert as a bug without this.
    const email = compose({
      kind: "revert-completed",
      campaignId: "c1",
      campaignName: "Summer",
      counts: counts(),
    });
    expect(email.text).toContain("recomputes");
    expect(email.text).toContain("another campaign still covers");
  });

  it("tells a drift email that the edits were deliberate and untouched", () => {
    const email = compose({ kind: "drift-hold", campaignId: "c1", campaignName: "Summer", driftedCount: 3 });
    expect(email.subject).toContain("changed outside the app");
    expect(email.text).toContain("has not overwritten them");
  });

  it("counts in the singular for one and groups large counts, subject and body (#759)", () => {
    const one = compose({ kind: "run-completed", campaignId: "c1", campaignName: "Summer", counts: counts({ verified: 1 }) });
    expect(one.subject).toBe('"Summer" finished — 1 variant updated');

    const partial = compose({ kind: "run-partial", campaignId: "c1", campaignName: "Summer", counts: counts({ failed: 1 }) });
    expect(partial.subject).toBe('"Summer" finished partially — 1 row needs attention');

    const big = compose({ kind: "run-partial", campaignId: "c1", campaignName: "Summer", counts: counts({ verified: 3669, unverified: 1200 }) });
    expect(big.subject).toContain("1,200 rows need attention");
    expect(big.text).toContain("Variants updated and verified: 3,669");

    const drift = compose({ kind: "drift-hold", campaignId: "c1", campaignName: "Summer", driftedCount: 1 });
    expect(drift.subject).toBe('"Summer" — 1 price changed outside the app');

    const digest = compose({ kind: "weekly-digest", shopName: "DartMode", campaignsRun: 1, variantsChanged: 123_456, driftOpen: 0, partialRuns: 0 });
    expect(digest.text).toContain("Variants changed: 123,456");
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

describe("the test email (#1122)", () => {
  it("says it is a test, names the store, and lists what the merchant will be emailed about", () => {
    const email = compose({
      kind: "test",
      shopName: "boltify-apps.myshopify.com",
      switchedOn: ["A run did not finish cleanly", "A campaign was reverted"],
    });
    expect(email.subject).toBe("Test email from Anchor for boltify-apps.myshopify.com");
    expect(email.text).toContain("Settings → Notifications");
    expect(email.text).toContain("  - A run did not finish cleanly\n  - A campaign was reverted");
  });

  it("says so when every notification is off, rather than listing nothing", () => {
    const email = compose({ kind: "test", shopName: "DartMode", switchedOn: [] });
    expect(email.text).toContain("Every notification is switched off");
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
            campaignId: "c1",
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
      campaignId: "c1",
      campaignName: "$5 off everything",
      counts: counts(),
    });
    expect(email.subject).toContain("$5 off everything");
    // Everything the app itself generated is still clean.
    expect(email.text.replace("$5 off everything", "")).not.toMatch(MONEY);
  });

  it("holds for a test email", () => {
    const email = compose({ kind: "test", shopName: "DartMode", switchedOn: ["A campaign was reverted"] });
    expect(email.subject).not.toMatch(MONEY);
    expect(email.text).not.toMatch(MONEY);
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
