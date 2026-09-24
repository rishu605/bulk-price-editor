/**
 * A misconfigured market reaches the merchant as itself, not as `UNKNOWN`.
 *
 * `unconvertedMessage` writes the sentence the error taxonomy asks for: it names the
 * market, says it answered in USD rather than CAD, and points at Settings → Markets.
 * That sentence was then thrown as a bare `Error`, so `classify` matched none of its
 * patterns, `toAppError` filed it under `UNKNOWN`, and the merchant was shown
 * "Something went wrong on our side. Nothing was changed in your store" instead.
 *
 * Four of those are recorded on `dartmode-labs` from 2026-09-22, all on
 * `/app/campaigns/$id`, all grouped on the diagnostics page under the one heading that
 * tells nobody anything. #646 stopped the throw escaping the preview; this is about what
 * the error is worth when something does catch it.
 */

import { describe, expect, it } from "vitest";

import { AppError, toAppError } from "../../lib/errors/app-error";
import { helpLabelFor, helpPathOf } from "../../lib/errors/help-links";
import { unconvertedMessage } from "../../lib/markets/conversion-check";
import { UnconvertedMarketError } from "./market-plan.server";

const thrown = () =>
  new UnconvertedMarketError(
    "gid://shopify/PriceList/1",
    "CAD",
    unconvertedMessage("Canada Buyers", "CAD", "USD"),
  );

describe("an unconverted market carries its own code", () => {
  it("is classified as a market problem rather than as UNKNOWN", () => {
    expect(toAppError(thrown()).code).toBe("MARKET_MISCONFIGURED");
  });

  it("shows the merchant the sentence that names the market and the fix", () => {
    const shown = toAppError(thrown()).userMessage;

    expect(shown).toContain("Canada Buyers");
    expect(shown).toContain("CAD");
    expect(shown).toContain("Settings → Markets");
    // The generic text is the thing this replaces, so it must not be what comes back.
    expect(shown).not.toContain("Something went wrong on our side");
  });

  it("survives `toAppError` untouched, rather than being re-classified", () => {
    // `toAppError` returns an `AppError` as-is. If this class ever stopped being one,
    // the message would be replaced by the generic text for its code and the market's
    // name would be lost -- silently, because the code would still look right.
    const error = thrown();

    expect(error).toBeInstanceOf(AppError);
    expect(toAppError(error)).toBe(error);
  });

  it("keeps `message` as the merchant sentence, for the callers that push it", () => {
    // `market-surfaces.server.ts` and `preview.server.ts` both collect `error.message`
    // into the list of refusals a merchant reads. Changing the base class must not have
    // changed what that string is.
    expect(thrown().message).toBe(unconvertedMessage("Canada Buyers", "CAD", "USD"));
  });

  it("keeps the price list and currency for whoever catches it", () => {
    const error = thrown();

    expect(error.priceListGid).toBe("gid://shopify/PriceList/1");
    expect(error.currency).toBe("CAD");
    // Context goes to the log. Prices must never be in it -- CLAUDE.md's telemetry rule.
    expect(error.context).toEqual({
      priceListGid: "gid://shopify/PriceList/1",
      currency: "CAD",
    });
  });

  it("is not retryable, because only the merchant can fix it", () => {
    // Retrying an unchanged market setting reproduces the same refusal. The worker reads
    // this flag to decide whether to try again.
    expect(thrown().retryable).toBe(false);
    expect(thrown().status).toBe(422);
  });

  it("has somewhere for the merchant to read more", () => {
    expect(helpPathOf("MARKET_MISCONFIGURED")).toBe("/failures/market-currency");
    expect(helpLabelFor("MARKET_MISCONFIGURED")).not.toBe(
      helpLabelFor("SOMETHING-THAT-IS-NOT-A-CODE"),
    );
  });
});
