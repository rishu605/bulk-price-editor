/**
 * The preview's first request describes the form a merchant is looking at.
 *
 * It cannot be read off that form. At mount the editor's fields are Polaris custom
 * elements, and serialising them at that instant produced a scope matching nothing where
 * an empty filter matches everything — the panel said "Nothing matches this scope" beside
 * a catalogue of 3,669 (#470). So this builds the payload instead, and only later
 * requests read the form.
 *
 * Which makes it the one statement of what an untouched editor asks for, and worth
 * pinning: the failure it prevents is a merchant's first impression of the panel being a
 * confidently wrong number, which is worse than no number.
 *
 * In `lib/` rather than beside the route for two reasons, both learned the hard way: a
 * `.test.ts` under `app/routes/` becomes a route and breaks the browser build, and
 * importing the route to reach the function drags in `shopify.server` and Prisma.
 */

import { describe, expect, it } from "vitest";

import { DRAFT_DEFAULTS } from "./draft-defaults";
import { firstPreviewParams } from "./first-preview";

const ROUNDING = { default: "charm99", byCurrency: { JPY: "whole" } };
const noUrl = () => new URLSearchParams();

describe("what an untouched editor asks for", () => {
  it("carries the rule the fields render", () => {
    const params = firstPreviewParams(ROUNDING, noUrl());

    expect(params.get("ruleKind")).toBe(DRAFT_DEFAULTS.ruleKind);
    expect(params.get("ruleValue")).toBe(DRAFT_DEFAULTS.percentValue);
    expect(params.get("compareAt")).toBe(DRAFT_DEFAULTS.compareAt);
  });

  it("carries no scope, because an empty filter is every variant", () => {
    // The bug: anything in here that reaches `astFrom` as a condition turns "everything"
    // into "nothing", and the panel reports that as an empty scope rather than an error.
    const params = firstPreviewParams(ROUNDING, noUrl());

    for (const field of ["collection", "tag", "vendor", "title", "segment"]) {
      expect(params.get(field), `${field} narrows a scope nobody narrowed`).toBeNull();
    }
  });

  it("carries the shop's rounding, not the fallback of none", () => {
    // `readRoundingPolicy` falls back to "none" when the field is absent, while the
    // select renders the store's setting — so omitting it previews a rounding rule the
    // merchant can see is not the one selected.
    const params = firstPreviewParams(ROUNDING, noUrl());

    expect(params.get("rounding.default")).toBe("charm99");
    expect(params.get("rounding.JPY")).toBe("whole");
  });
});

describe("choices the merchant has already made", () => {
  it("takes the scope from the URL, which is what the fields render", () => {
    const params = firstPreviewParams(ROUNDING, new URLSearchParams("collection=Outerwear&tag=sale"));

    expect(params.get("collection")).toBe("Outerwear");
    expect(params.get("tag")).toBe("sale");
  });

  it("lets a segment through, since it replaces the filter entirely", () => {
    expect(firstPreviewParams(ROUNDING, new URLSearchParams("segment=seg_1")).get("segment")).toBe(
      "seg_1",
    );
  });

  it("ignores an empty parameter rather than treating it as a filter", () => {
    // `?collection=` is how a cleared select arrives. Setting it would scope the preview
    // to products whose collection is the empty string, which is none of them — the same
    // shape as the bug this function exists to fix.
    expect(
      firstPreviewParams(ROUNDING, new URLSearchParams("collection=")).get("collection"),
    ).toBeNull();
  });

  it("keeps the shop's rounding when the URL carries unrelated parameters", () => {
    const params = firstPreviewParams(ROUNDING, new URLSearchParams("startAt=2026-09-01&guided=1"));

    expect(params.get("rounding.default")).toBe("charm99");
    expect(params.get("startAt")).toBe("2026-09-01");
  });
});
