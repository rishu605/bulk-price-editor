/**
 * Every shape Home's action can return, put through the banner.
 *
 * Two of the four paths return no `errors`, and the banner used to map over it
 * unconditionally — so resolving a market notice, or typing an invalid percentage into
 * "Put everything on sale", replaced the page with the error boundary. Both are ordinary
 * merchant actions, and the notice had already been resolved by the time the page fell
 * over, so reloading no longer said what had happened.
 *
 * The cases below are the action's real returns, copied from `app/routes/app._index.tsx`.
 */

import { describe, expect, it } from "vitest";

import { resultBanner } from "./action-result";

describe("a reply with no errors field", () => {
  it("survives resolving a market notice", () => {
    // `{ ok: true, message }` — the resolve-notice path.
    const banner = resultBanner({ ok: true, message: "Thanks — that market question is settled." });

    expect(banner).not.toBeNull();
    expect(banner?.errors, "mapping over undefined is what took the page down").toEqual([]);
    expect(banner?.tone).toBe("success");
  });

  it("survives a percentage the parser refused", () => {
    // `{ ok: false, message }` — the quick-campaign path.
    const banner = resultBanner({ ok: false, message: "Enter a percentage between 1 and 99." });

    expect(banner?.errors).toEqual([]);
    expect(banner?.tone).toBe("critical");
  });
});

describe("a reply that carries detail", () => {
  it("keeps the lines the sync reported", () => {
    const banner = resultBanner({
      ok: false,
      message: "Synced 3,669 variants across 1,037 products.",
      errors: ["Product 12 has no price", "Product 44 has no price"],
    });

    expect(banner?.errors).toHaveLength(2);
    expect(banner?.tone).toBe("critical");
  });

  it("is a success when the action says so, detail or not", () => {
    expect(resultBanner({ ok: true, message: "Synced.", errors: [] })?.tone).toBe("success");
  });
});

describe("no reply at all", () => {
  it("renders nothing rather than an empty banner", () => {
    // The page's first load, and every load after one that did not submit anything.
    expect(resultBanner(undefined)).toBeNull();
  });
});
