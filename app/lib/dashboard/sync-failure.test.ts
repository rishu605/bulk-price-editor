/**
 * What Home says to a store whose currency Anchor cannot price (#1089).
 */

import { describe, expect, it } from "vitest";

import { SUPPORT_ADDRESS } from "../support/contact";
import { sourceOf } from "../testing/source";
import {
  SYNC_STOPPED_HEADING,
  syncFailureHeading,
  UNPRICED_CURRENCY_HEADING,
  unpricedCurrencyFailure,
} from "./sync-failure";

describe("a store whose currency has no precision", () => {
  it("names a code a later schema adds, says nothing was read or changed, and how to hear when it is added", () => {
    expect(unpricedCurrencyFailure("XCG")).toBe(
      "Anchor can't price in your store's currency, XCG, yet: it does not know how many decimal places XCG prices " +
        "have. Anchor read none of your products rather than guess, and nothing in your store was changed. Support " +
        `has been sent this so XCG can be added; write to ${SUPPORT_ADDRESS} to hear when, then sync again from here.`,
    );
  });

  it("says XXX is Shopify not recognising the currency, which is the merchant's to check", () => {
    const failure = unpricedCurrencyFailure("XXX");
    expect(failure).toMatch(/^Anchor can't price in your store's currency: Shopify reports it as XXX,/);
    expect(failure).toMatch(/Support has been sent this\. Check the store currency in your Shopify settings, then sync again from here\.$/);
  });

  it("is headed as a currency Anchor cannot price, not as a sync that failed", () => {
    expect(syncFailureHeading(unpricedCurrencyFailure("XXX"))).toBe(UNPRICED_CURRENCY_HEADING);
    expect(syncFailureHeading(unpricedCurrencyFailure("XCG"))).toBe(UNPRICED_CURRENCY_HEADING);
    expect(UNPRICED_CURRENCY_HEADING).toBe("Anchor can't price in your store's currency");
  });

  it("leaves every other sync failure under the heading it had", () => {
    const stopped = "The last sync stopped while capturing baselines: boom. Run it again: it picks up what is already captured.";
    expect(syncFailureHeading(stopped)).toBe(SYNC_STOPPED_HEADING);
    expect(SYNC_STOPPED_HEADING).toBe("The last sync did not finish cleanly");
  });

  it("is the heading Home's banner uses", () => {
    expect(sourceOf("app/routes/app._index.tsx")).toContain("heading: syncFailureHeading(syncNow.failure)");
  });
});
