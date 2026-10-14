/**
 * Turning a stored before/after into a line somebody can read.
 *
 * The audit log answers two questions: "what did this app do to my prices?" and "who
 * turned that off?". A summary reading "settings updated" answers neither, so the
 * field-level difference is the point rather than a nicety.
 */

import { describe, expect, it } from "vitest";

import { auditMoney } from "../lib/audit/money";
import { summarise } from "./activity.server";

describe("summarise", () => {
  it("names the fields that changed and both values", () => {
    expect(
      summarise("settings.guardrails.update", { minPrice: null }, { minPrice: 5 }),
    ).toBe("minPrice: — → 5");
  });

  it("reports several changes in one line", () => {
    const line = summarise(
      "settings.guardrails.update",
      { neverBelowCost: false, violationPolicy: "clamp" },
      { neverBelowCost: true, violationPolicy: "block" },
    );
    expect(line).toContain("neverBelowCost: false → true");
    expect(line).toContain("violationPolicy: clamp → block");
  });

  it("says so when an update changed nothing", () => {
    // Distinct from "no record". A merchant who saved a form and sees the entry needs
    // to know the save landed and simply moved nothing.
    expect(summarise("settings.guardrails.update", { minPrice: 5 }, { minPrice: 5 })).toBe(
      "no fields changed",
    );
  });

  it("describes a creation, which has an after and no before", () => {
    // A variant the catalogue mirror has no title for is still named, by its GID: it may
    // have been deleted since, and a blank would read as nothing having been recorded.
    expect(summarise("campaign.variant.excluded", null, { variantGid: "gid://v/1" })).toBe(
      "variant: gid://v/1",
    );
  });

  it("falls back to the action name when there is nothing stored", () => {
    // Entries recorded before summaries existed must still read as something.
    expect(summarise("campaign.transition", null, null)).toBe("campaign.transition");
  });

  it("summarises arrays by count rather than dumping them", () => {
    // A frozen segment's variant list is thousands of gids. Rendering it would make
    // the row unreadable and the page enormous.
    expect(summarise("segment.update", null, { variantGids: ["a", "b", "c"] })).toBe(
      "variantGids: 3 item(s)",
    );
    expect(summarise("segment.update", null, { variantGids: [] })).toBe("variantGids: none");
  });

  it("truncates a long string rather than letting one row swallow the table", () => {
    const long = "x".repeat(200);
    const line = summarise("campaign.transition", null, { reason: long });
    expect(line.length).toBeLessThan(80);
    expect(line).toContain("…");
  });
});

/**
 * Prices in the log (#757).
 *
 * Resolving a drift on a $701.00 snowboard was logged as "observedPrice: 70100" -- the
 * minor units, which a merchant reads as $70,100, and which in a zero-decimal currency
 * would have been right by accident. Prices are now written with their currency and shown
 * as the merchant would write them.
 */
describe("a price in an entry", () => {
  const GID = "gid://shopify/ProductVariant/45725717004522";
  const titles = new Map([[GID, "The Minimal Snowboard"]]);
  const drift = (minor: bigint, currency: string) =>
    // Through JSON, as the row comes back from the database: the shape the reader sees is
    // what Postgres returns, not the object the writer built.
    JSON.parse(JSON.stringify({ variantGid: GID, observedPrice: auditMoney(minor, currency) }));

  it("reads a drift entry in dollars as dollars, naming the variant by title", () => {
    expect(summarise("drift.ignore", null, drift(70100n, "USD"), { titles })).toBe(
      "variant: The Minimal Snowboard, observedPrice: $701.00",
    );
  });

  it("reads the same entry in yen with no decimals", () => {
    // The number that read right by accident before: 701 minor units is ¥701. And 70100
    // is ¥70,100 -- never ¥701.00, which is a price no yen store can charge.
    expect(summarise("drift.ignore", null, drift(701n, "JPY"), { titles })).toBe(
      "variant: The Minimal Snowboard, observedPrice: ¥701",
    );
    expect(summarise("drift.adopt", null, drift(70100n, "JPY"), { titles })).toBe(
      "variant: The Minimal Snowboard, observedPrice: ¥70,100",
    );
  });

  it("uses the currency's own precision, not two decimals", () => {
    expect(summarise("drift.ignore", null, drift(1500n, "KWD"))).toContain("KWD\u00a01.500");
  });

  it("keeps an unregistered currency's code beside the number rather than guessing", () => {
    expect(summarise("drift.ignore", null, drift(70100n, "ZZZ"))).toContain("observedPrice: 701.00 ZZZ");
  });

  it("shows a missing price as a dash, not as the word null", () => {
    expect(summarise("drift.ignore", null, { variantGid: GID, observedPrice: auditMoney(null, "USD") }, { titles }))
      .toBe("variant: The Minimal Snowboard, observedPrice: —");
  });

  it("shows both sides of a changed price", () => {
    expect(
      summarise(
        "baseline.edit",
        { basePrice: auditMoney(70100n, "USD") },
        { basePrice: auditMoney(64900n, "USD") },
      ),
    ).toBe("basePrice: $701.00 → $649.00");
  });

  it("leaves a number that is not a price as the number it is", () => {
    // `minPrice` is the guardrail floor, stored in major units as the merchant typed it:
    // 5 is $5. A rule keyed on the field name would show it as "$0.05". Counts are counts.
    expect(summarise("settings.guardrails.update", { minPrice: null }, { minPrice: 5 })).toBe(
      "minPrice: — → 5",
    );
    expect(summarise("notification.drift", null, { pending: 70100 })).toBe("pending: 70100");
  });

  it("does not guess at a bare number in a price-shaped field", () => {
    // Without a currency the summariser cannot know 70100 is $701.00 rather than ¥70,100,
    // so it does not pretend to. The service recovers the currency for the one writer that
    // stored prices this way; anything else stays as written.
    expect(summarise("drift.ignore", null, { observedPrice: "70100" })).toBe("observedPrice: 70100");
  });

  it("does not format an object that merely has a currency in it", () => {
    // A market snapshot carries `currency` beside other fields. Only the exact shape
    // `auditMoney` writes is a price.
    expect(summarise("market.added", null, { snapshot: { minor: "1", currency: "EUR", name: "EU" } })).toBe(
      'snapshot: {"minor":"1","currency":"EUR","name":"EU"}',
    );
  });
});
