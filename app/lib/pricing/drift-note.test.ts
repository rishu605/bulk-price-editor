/**
 * When the preview has to admit the storefront disagrees with the baseline.
 *
 * The column exists because our arithmetic starts somewhere no competitor's does. It has
 * to stay quiet in the ordinary case, or a merchant learns to ignore it and it is not
 * there when it matters.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { liveIfDrifted } from "./drift-note";

describe("saying the live price only when it differs", () => {
  it("says nothing when the storefront agrees with the baseline", () => {
    expect(liveIfDrifted(money(4000, "USD"), money(4000, "USD"))).toBeNull();
  });

  it("reports the live price when the storefront has moved", () => {
    expect(liveIfDrifted(money(4000, "USD"), money(2800, "USD"))).toEqual(money(2800, "USD"));
  });

  it("treats a different currency as a disagreement rather than throwing", () => {
    // `equals` throws CurrencyMismatchError, which is right for arithmetic and wrong
    // here: a preview is the last place that should crash rather than report.
    expect(() => liveIfDrifted(money(4000, "USD"), money(4000, "EUR"))).not.toThrow();
    expect(liveIfDrifted(money(4000, "USD"), money(4000, "EUR"))).toEqual(money(4000, "EUR"));
  });

  it("says nothing when either side is missing", () => {
    // A variant with no baseline cannot be priced at all and is counted separately; a
    // variant with no mirrored live price is unknown, and unknown is not drift.
    expect(liveIfDrifted(null, money(2800, "USD"))).toBeNull();
    expect(liveIfDrifted(money(4000, "USD"), null)).toBeNull();
    expect(liveIfDrifted(undefined, undefined)).toBeNull();
  });

  it("does not mistake a zero price for an absent one", () => {
    // A free variant has a real price of zero. Falsy checks on the Money object are
    // safe; a falsy check on `.amount` would silently drop the row.
    expect(liveIfDrifted(money(4000, "USD"), money(0, "USD"))).toEqual(money(0, "USD"));
  });
});
