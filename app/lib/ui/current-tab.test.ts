/**
 * Which tab is current, and how a screen reader is told (#1016).
 *
 * A section tab is current on its own page and on the pages beneath it: Baselines is lit
 * on Baselines → recapture, because that page is about what Baselines lists. Both were
 * marked `aria-current="page"`, which tells a screen reader the link goes to the page it
 * is on -- false beneath it, where pressing the tab goes up a level. `"true"` is the value
 * for "the current item in a set" that is not this exact page.
 */

import { describe, expect, it } from "vitest";

import { ariaCurrent, currentness } from "./current-tab";

const PRICES = [{ href: "/app/prices" }, { href: "/app/prices/baselines" }, { href: "/app/prices/costs" }];

describe("currentness", () => {
  it("is the page itself on the tab's own page", () => {
    expect(currentness("/app/prices/baselines", "/app/prices/baselines", PRICES)).toBe("page");
    expect(currentness("/app/prices", "/app/prices", PRICES)).toBe("page");
  });

  it("is beneath on a page under the tab", () => {
    expect(currentness("/app/prices/baselines/recapture", "/app/prices/baselines", PRICES)).toBe("beneath");
  });

  it("is neither for another tab, a sibling with the same letters, or the section root from below", () => {
    expect(currentness("/app/prices/baselines", "/app/prices/costs", PRICES)).toBe(false);
    expect(currentness("/app/prices/baselines", "/app/prices", PRICES)).toBe(false);
    expect(currentness("/app/prices/baselines", "/app/prices/base", [{ href: "/app/prices" }, { href: "/app/prices/base" }])).toBe(
      false,
    );
  });
});

describe("ariaCurrent", () => {
  it("says page on the tab's own page", () => {
    expect(ariaCurrent("page")).toBe("page");
    expect(ariaCurrent(true)).toBe("page");
  });

  it("says true beneath it, which is the current item and not this page", () => {
    expect(ariaCurrent("beneath")).toBe("true");
  });

  it("says nothing on a tab that is not current", () => {
    expect(ariaCurrent(false)).toBeUndefined();
    expect(ariaCurrent(undefined)).toBeUndefined();
  });
});
