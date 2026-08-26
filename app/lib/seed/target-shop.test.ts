/**
 * Which store a destructive script writes to.
 *
 * The failure being prevented is a hundred thousand products landing in the wrong
 * catalogue — which cannot be undone quickly, and makes every perf number taken
 * afterwards meaningless. So the interesting tests are the refusals.
 */

import { describe, expect, it } from "vitest";

import { AmbiguousShopError, chooseShop, shopArg, UnknownShopError } from "./target-shop";

const shops = (...domains: string[]) => domains.map((domain) => ({ domain }));

describe("with one store installed", () => {
  it("uses it without being asked", () => {
    expect(chooseShop(shops("a.myshopify.com"), undefined).domain).toBe("a.myshopify.com");
  });

  it("still refuses a name that is not it", () => {
    // Silently ignoring the flag would write to a store the caller explicitly did not name.
    expect(() => chooseShop(shops("a.myshopify.com"), "b")).toThrow(UnknownShopError);
  });
});

describe("with more than one", () => {
  const installed = shops("anchor-perf.myshopify.com", "boltify-apps.myshopify.com");

  it("refuses to guess", () => {
    expect(() => chooseShop(installed, undefined)).toThrow(AmbiguousShopError);
  });

  it("says which stores it could have meant", () => {
    // A refusal that does not say what to do next just makes somebody run it again.
    try {
      chooseShop(installed, undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("--shop");
      expect((error as Error).message).toContain("anchor-perf.myshopify.com");
      expect((error as Error).message).toContain("boltify-apps.myshopify.com");
    }
  });

  it("takes an exact domain", () => {
    expect(chooseShop(installed, "anchor-perf.myshopify.com").domain).toBe(
      "anchor-perf.myshopify.com",
    );
  });

  it("takes the prefix a person actually types", () => {
    expect(chooseShop(installed, "anchor-perf").domain).toBe("anchor-perf.myshopify.com");
  });

  it("refuses a prefix that matches two", () => {
    const ambiguous = shops("shop-one.myshopify.com", "shop-two.myshopify.com");

    // "shop" is not a choice, it is a coin toss with extra steps.
    expect(() => chooseShop(ambiguous, "shop")).toThrow(UnknownShopError);
  });

  it("does not treat a prefix as a substring", () => {
    // "perf" must not match "anchor-perf": that is the kind of match that picks the wrong
    // store on a busy account.
    expect(() => chooseShop(installed, "perf")).toThrow(UnknownShopError);
  });
});

describe("with none installed", () => {
  it("refuses rather than reporting success on an empty account", () => {
    expect(() => chooseShop([], undefined)).toThrow(UnknownShopError);
  });
});

describe("reading the flag", () => {
  it("finds the value after --shop", () => {
    expect(shopArg(["2000", "--shop", "anchor-perf", "--variants", "50"])).toBe("anchor-perf");
  });

  it("is undefined when the flag is absent", () => {
    expect(shopArg(["2000", "--variants", "50"])).toBeUndefined();
  });

  it("is undefined when the flag has no value", () => {
    expect(shopArg(["--shop"])).toBeUndefined();
  });
});
