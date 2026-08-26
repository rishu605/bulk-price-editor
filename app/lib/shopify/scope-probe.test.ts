/**
 * Reading a scope probe's answer.
 *
 * The one classification that must never be wrong is a throttle or an outage being read
 * as a missing scope. That mistake sends somebody to widen the manifest, which forces a
 * re-authorisation prompt on every existing install — the exact cost this task exists to
 * avoid. So "I could not tell" has to be a verdict of its own, and it has to be the
 * default for anything unfamiliar.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyProbe, minimalScopes, PROBES, scopeGaps } from "./scope-probe";

describe("classifyProbe", () => {
  it("reads a userErrors response as granted", () => {
    // The mutation resolved, considered our deliberate nonsense and declined it. That is
    // the shape almost every probe produces on a healthy shop, and it is a pass.
    const result = classifyProbe({
      data: {
        priceListFixedPricesAdd: {
          userErrors: [{ field: ["priceListId"], message: "Price list does not exist" }],
        },
      },
    });

    expect(result.verdict).toBe("granted");
    expect(result.detail).toBe("Price list does not exist");
  });

  it("reads a clean success as granted", () => {
    const result = classifyProbe({ data: { stagedUploadsCreate: { userErrors: [] } } });

    expect(result.verdict).toBe("granted");
  });

  it("reads an access denial as denied, and quotes the scope Shopify named", () => {
    const result = classifyProbe({
      errors: [
        {
          message:
            "Access denied for markets field. Required access: `read_markets` access scope.",
        },
      ],
      data: null,
    });

    expect(result.verdict).toBe("denied");
    expect(result.requires).toBe("read_markets");
  });

  it("does not mistake a throttle for a missing scope", () => {
    // Shopify sends request-level failures as a bare object, not the array the spec
    // describes. Treating this as a denial would be an argument for adding a scope the
    // app already has.
    const result = classifyProbe({ errors: { query: "Throttled" } });

    expect(result.verdict).toBe("inconclusive");
    expect(result.detail).toContain("Throttled");
  });

  it("does not mistake an empty response for a granted scope", () => {
    expect(classifyProbe({}).verdict).toBe("inconclusive");
    expect(classifyProbe({ data: {} }).verdict).toBe("inconclusive");
  });
});

describe("the probes themselves", () => {
  it("never sends an input that could write something", () => {
    // The safety property the whole approach rests on. Every probe is meant to fail
    // validation, and it can only be trusted to fail if its ids cannot resolve and its
    // lists are empty. A probe that grew a real id in a later edit would quietly start
    // mutating the shop it was checking.
    const serialised = JSON.stringify(PROBES.map((probe) => probe.variables));

    const ids = serialised.match(/gid:\/\/shopify\/\w+\/(\d+)/g) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(/\/9007199254740991$/);
    }

    // Anything that would carry a payload — prices, tags, variants — is empty.
    for (const probe of PROBES) {
      for (const value of Object.values(probe.variables)) {
        if (Array.isArray(value)) expect(value).toHaveLength(0);
      }
    }
  });

  it("covers every mutation the architecture depends on", () => {
    const names = PROBES.map((probe) => probe.name);

    // RFC §6's list. If a mutation is added to the engine and not here, the scope set
    // stops being empirical and goes back to being a guess.
    for (const required of [
      "productVariantsBulkUpdate",
      "bulkOperationRunMutation",
      "bulkOperationRunQuery",
      "stagedUploadsCreate",
      "priceListCreate",
      "priceListUpdate",
      "priceListFixedPricesAdd",
      "priceListFixedPricesDelete",
      "quantityPricingByVariantUpdate",
      "catalogCreate",
      "catalogUpdate",
      "tagsAdd",
      "tagsRemove",
    ]) {
      expect(names).toContain(required);
    }
  });
});

describe("per-market compare-at, as a schema fact", () => {
  /**
   * The wedge, asserted against the generated schema rather than against a belief.
   *
   * **It closed in 2026-07.** `priceListFixedPricesByProductUpdate` used to have no
   * compare-at field at all, while the variant-level mutation had one. That asymmetry is
   * almost certainly why the ecosystem believed Shopify could not do per-market
   * strike-throughs, and it was the product's differentiator. `PriceListProductPriceInput`
   * now carries `compareAtPrice`, so the moat is a head start rather than a wall.
   *
   * This test was written to fail on exactly this change, and it did — on the API version
   * bump, rather than when a competitor shipped it. Now inverted: it asserts the field is
   * present, so the *next* silent move here is caught too.
   *
   * Nothing in the engine changes. The app writes per-variant because a campaign resolves
   * per variant, and a product-level mutation cannot express two variants of one product
   * at different prices. What changed is the commercial claim, not the code.
   */
  const schema = fs.readFileSync(
    path.join(process.cwd(), "app/types/admin.types.d.ts"),
    "utf8",
  );

  const inputFields = (name: string) => {
    const body = new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(schema);
    expect(body, `${name} missing from the generated schema`).not.toBeNull();
    return body![1];
  };

  it("the product-level input gained compare-at in 2026-07", () => {
    // Was `.not.toMatch` until the version bump. Kept as an assertion rather than
    // deleted: the field appearing and disappearing again is exactly as significant as
    // it appearing was, and a deleted test notices neither.
    expect(inputFields("PriceListProductPriceInput")).toMatch(/compareAtPrice/);
  });

  it("the variant-level input still has one", () => {
    expect(inputFields("PriceListPriceInput")).toMatch(/compareAtPrice/);
  });

  it("still cannot express two variants of one product at different prices", () => {
    // The reason the engine writes per-variant is unchanged by the above: the
    // product-level input takes one price for the whole product, and a campaign that
    // resolves per variant cannot be expressed through it.
    const fields = inputFields("PriceListProductPriceInput");

    expect(fields).toMatch(/productId/);
    expect(fields).not.toMatch(/variantId/);
  });
});

describe("minimalScopes", () => {
  it("drops a read scope its write counterpart already implies", () => {
    // The finding that came out of the first real run: the manifest asked for
    // `read_markets` alongside `write_markets`, and Shopify's own record of what was
    // granted had already collapsed the pair. One fewer checkbox on the install screen,
    // for no loss of access.
    expect(minimalScopes(["write_products", "read_products", "write_markets"])).toEqual([
      "write_markets",
      "write_products",
    ]);
  });

  it("keeps a read scope with no write counterpart", () => {
    // `read_companies` has no write half in play — B2B catalog assignment is displayed,
    // never edited — so this one is a genuine addition when P6.1 ships.
    expect(minimalScopes(["write_products", "read_companies"])).toEqual([
      "read_companies",
      "write_products",
    ]);
  });
});

describe("scopeGaps", () => {
  it("reports a write scope as over-broad when only the read was exercised", () => {
    // The finding from the first real run. Nothing the app does *writes* a market — the
    // market surface works by creating and updating price lists, which `write_products`
    // covers. All we ever do to markets themselves is read which ones exist.
    const gaps = scopeGaps(
      ["write_markets", "write_products"],
      ["read_markets", "write_products"],
    );

    expect(gaps.overBroad).toEqual(["write_markets"]);
    expect(gaps.missing).toEqual([]);
    expect(gaps.unneeded).toEqual([]);
  });

  it("counts a granted write as covering a needed read", () => {
    // Otherwise every run would report `read_markets` missing while it plainly works,
    // and a report that cries wolf is a report nobody reads twice.
    expect(scopeGaps(["write_markets"], ["read_markets"]).missing).toEqual([]);
  });

  it("reports a genuinely absent scope as missing", () => {
    expect(scopeGaps(["write_products"], ["read_companies"]).missing).toEqual([
      "read_companies",
    ]);
  });

  it("separates unneeded from over-broad", () => {
    // `write_orders` has no read counterpart in the needed set either — nothing in the
    // app touches orders at all, so it is a checkbox to delete rather than one to
    // narrow. Different finding, different fix.
    const gaps = scopeGaps(["write_orders", "write_products"], ["write_products"]);

    expect(gaps.unneeded).toEqual(["write_orders"]);
    expect(gaps.overBroad).toEqual([]);
  });
});
