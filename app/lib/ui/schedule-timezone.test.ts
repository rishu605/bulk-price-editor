/**
 * The schedule says whose clock it is on.
 *
 * NA writes the zone *and* the current time in it under its date pickers; Sami shows the
 * zone and lets you change it; RUBIX shows nothing, which is worse than either. A sale set
 * to start at midnight in a zone the merchant guessed wrong is a support ticket and a
 * refund, and a zone name alone does not settle it — "Asia/Calcutta" is a string half the
 * people it applies to would not pick out of a list. A clock they can compare against the
 * one on their wall settles it in a second.
 */

import { describe, expect, it } from "vitest";

import { formatClock } from "../format/display";
import { sourceOf } from "../testing/source";

const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");

describe("the schedule's timezone line", () => {
  it("names the zone and says what time it is there", () => {
    expect(EDITOR).toContain("{timeZone}");
    expect(EDITOR).toContain("{timeZoneNow}");
  });

  it("computes the clock on the server", () => {
    // A time rendered from the browser's clock differs between the server render and
    // hydration, and React replaces it — the same trap `formatAgo` carries a paragraph
    // about. The value is built in the loader.
    expect(EDITOR).toContain("timeZoneNow: formatClock(new Date(), shop.timezone)");
  });

  it("sends the merchant to where the zone actually lives", () => {
    // Deliberately not our own Settings. The zone is synced from Shopify's
    // `ianaTimezone` — see `catalog-sync.server.ts` — and a second, editable copy here
    // would let campaign times drift from the timestamps on the merchant's own orders.
    // A setting that disagrees with the platform's is worse than one you cannot edit.
    expect(EDITOR).toMatch(/Shopify store settings/);
  });
});

describe("formatClock", () => {
  const noon = new Date("2026-08-29T12:00:00Z");

  it("shows the time in the zone it was given, not the server's", () => {
    expect(formatClock(noon, "UTC")).toBe("12:00");
    expect(formatClock(noon, "America/New_York")).toBe("08:00");
    expect(formatClock(noon, "Asia/Kolkata")).toBe("17:30");
  });

  it("is 24-hour, like the fields it sits under", () => {
    // The start and end inputs say "24-hour, in your store's zone". A 12-hour clock in
    // the sentence explaining them would be the app disagreeing with itself in the one
    // place a merchant is checking the two against each other.
    expect(formatClock(new Date("2026-08-29T20:00:00Z"), "UTC")).toBe("20:00");
  });

  it("says nothing rather than crashing on a zone that does not exist", () => {
    // A shop row can carry whatever Shopify sent, and a scheduling page that throws is a
    // worse answer to a bad zone than a missing clock.
    expect(formatClock(noon, "Mars/Olympus")).toBe("");
  });
});
