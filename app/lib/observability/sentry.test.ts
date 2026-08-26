/**
 * What is allowed to leave the process.
 *
 * Sentry is a third party. A price that reaches it has left the merchant's control and
 * ours, and no amount of "we only send errors" makes that acceptable — so the scrubbing
 * is a hook rather than a convention, and this is what proves it.
 */

import { describe, expect, it } from "vitest";

import { redactPricesInText, scrub } from "./sentry.server";

describe("prices inside free text", () => {
  it("removes a price from the middle of a sentence", () => {
    // The realistic case. An exception message is one string, and the structured
    // redactor works on keys and values.
    expect(redactPricesInText("cannot set price 19.99 on variant 12345")).toBe(
      "cannot set price [price] on variant 12345",
    );
  });

  it("removes a formatted price with a symbol and separators", () => {
    expect(redactPricesInText("expected $1,299.00 but got £15.50")).toBe(
      "expected [price] but got [price]",
    );
  });

  it("leaves variant ids and counts alone", () => {
    // If this over-matched, every message would be unreadable and people would stop
    // reading them — which costs more than the leak it prevents.
    expect(redactPricesInText("412 of 1616 variants, gid://shopify/ProductVariant/12345"))
      .toBe("412 of 1616 variants, gid://shopify/ProductVariant/12345");
  });

  it("leaves a version number alone", () => {
    expect(redactPricesInText("API version 2025.10 is pinned")).toBe(
      "API version 2025.10 is pinned",
    );
  });
});

describe("scrubbing an event before it is sent", () => {
  it("scrubs the message", () => {
    const event = scrub({ message: "failed writing 19.99" } as never);

    expect(event.message).toBe("failed writing [price]");
  });

  it("scrubs an exception value", () => {
    const event = scrub({
      exception: { values: [{ type: "Error", value: "price 24.50 rejected" }] },
    } as never);

    expect(event.exception?.values?.[0].value).toBe("price [price] rejected");
  });

  it("redacts a price out of structured extra data", () => {
    const event = scrub({ extra: { intendedPrice: 1999, shopId: "s1" } } as never);

    expect(event.extra?.intendedPrice).not.toBe(1999);
    // The shop id survives, because that is the thing that makes an alert actionable.
    expect(event.extra?.shopId).toBe("s1");
  });

  it("redacts a token out of context", () => {
    const event = scrub({
      contexts: { anchor: { shopId: "s1", accessToken: "shpua_secret" } },
    } as never);

    expect(JSON.stringify(event.contexts?.anchor)).not.toContain("shpua_secret");
  });

  it("survives an event with nothing in it", () => {
    // A scrubber that threw would take out the error handler, which is how an app loses
    // the original error entirely.
    expect(() => scrub({} as never)).not.toThrow();
  });
});
