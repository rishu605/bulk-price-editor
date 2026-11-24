/**
 * A campaign's own floors and policy (#816, D30).
 *
 * The model always stored `guardrails` and the resolver always merged them, tighter only, but
 * nothing ever set one: every campaign was created with `{}`. These pin what the editor, its
 * preview, the save and the campaign page all read, through the one module that answers each.
 */

import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { policyOf } from "../money/rounding-policy";
import { NO_ROUNDING } from "../money/rounding";
import { resolve } from "../pricing/resolver";
import type { Guardrails, ResolvableCampaign } from "../pricing/types";
import {
  belowStore,
  campaignGuardrailsOf,
  describeFloors,
  draftFloorsView,
  FLOOR_FIELDS,
  floorFieldsFrom,
  floorFieldsOf,
  floorsApplying,
  floorsAudit,
  floorsFromForm,
  floorsView,
  looseningAsk,
  resolverGuardrails,
  stillToConfirm,
  typedLoosen,
  type CampaignGuardrails,
} from "./campaign-floors";

const usd = (amount: number) => money(amount, "USD");
const STORE: Guardrails = { neverBelowCost: true, minMarginPercent: 25, minPrice: usd(500), missingCostPolicy: "skip" };

/** The editor's fields as posted: the store's values, with `over` typed into them. */
function posted(over: Record<string, string | null> = {}) {
  const fields: Record<string, string | null> = {
    [FLOOR_FIELDS.marker]: "1",
    [FLOOR_FIELDS.neverBelowCost]: "1",
    [FLOOR_FIELDS.minMarginPercent]: "25",
    [FLOOR_FIELDS.minPrice]: "5.00",
    [FLOOR_FIELDS.policy]: "",
    ...over,
  };
  return (name: string) => fields[name] ?? null;
}

const read = (over: Record<string, string | null> = {}) => floorsFromForm(posted(over), "USD", STORE);

describe("what a form of floor fields saves", () => {
  it("is nothing when nobody touched them: the campaign follows the store, as before #816", () => {
    expect(read()).toEqual({ ok: true, floors: {}, below: [] });
    // "5" and "5.00" are the same price.
    expect(read({ [FLOOR_FIELDS.minPrice]: "5" })).toEqual({ ok: true, floors: {}, below: [] });
  });

  it("is nothing without the fields at all: Home's quick sale, an import, an old link", () => {
    expect(floorsFromForm(() => null, "USD", STORE)).toEqual({ ok: true, floors: {}, below: [] });
  });

  it("keeps a floor raised above the store's as the campaign's, and asks for nothing", () => {
    expect(read({ [FLOOR_FIELDS.minMarginPercent]: "40", [FLOOR_FIELDS.minPrice]: "12.50" })).toEqual({
      ok: true,
      floors: { minMarginPercent: 40, minPrice: usd(1_250) },
      below: [],
    });
    // Switched on where the store has it off.
    expect(floorsFromForm(posted(), "USD", { ...STORE, neverBelowCost: false })).toEqual({
      ok: true,
      floors: { neverBelowCost: true },
      below: [],
    });
  });

  it("names each floor set below the store's: lower, blank, or switched off", () => {
    expect(read({ [FLOOR_FIELDS.minMarginPercent]: "10" })).toEqual({ ok: true, floors: { minMarginPercent: 10 }, below: ["minMarginPercent"] });
    expect(read({ [FLOOR_FIELDS.minMarginPercent]: "" })).toEqual({ ok: true, floors: { minMarginPercent: null }, below: ["minMarginPercent"] });
    expect(read({ [FLOOR_FIELDS.neverBelowCost]: null })).toEqual({ ok: true, floors: { neverBelowCost: false }, below: ["neverBelowCost"] });
    expect(read({ [FLOOR_FIELDS.minPrice]: "1.00" })).toEqual({ ok: true, floors: { minPrice: usd(100) }, below: ["minPrice"] });
  });

  it("keeps a policy chosen for the campaign, and none left as the store's", () => {
    expect(read({ [FLOOR_FIELDS.policy]: "block" })).toEqual({ ok: true, floors: { violationPolicy: "block" }, below: [] });
    expect(read({ [FLOOR_FIELDS.policy]: "nonsense" })).toEqual({ ok: true, floors: {}, below: [] });
  });

  it("refuses a value that is not a floor, naming the field, as Settings does (#739, #1068)", () => {
    const margin = read({ [FLOOR_FIELDS.minMarginPercent]: "150" });
    expect(margin.ok).toBe(false);
    expect(!margin.ok && margin.problems[0]).toBe(
      "This campaign's minimum margin (%) must be a number from 0 to 99.9, or blank for none. “150” is not.",
    );
    const price = read({ [FLOOR_FIELDS.minPrice]: "9.995" });
    expect(!price.ok && price.problems[0]).toMatch(/^This campaign's minimum price \(USD\) 9\.995 has 3 decimal places/);
  });
});

describe("what the resolver is handed", () => {
  it("is nothing for a campaign stored before #816", () => {
    expect(resolverGuardrails(campaignGuardrailsOf({}))).toEqual({});
    expect(resolverGuardrails(campaignGuardrailsOf(null))).toEqual({});
  });

  it("tightens only, unless the floor was confirmed below the store's", () => {
    const tighter: CampaignGuardrails = { minMarginPercent: 40 };
    expect(floorsApplying(tighter, STORE, "USD").minMarginPercent).toBe(40);

    // Below the store's and not confirmed -- a copy's, say: the store's applies.
    const unconfirmed: CampaignGuardrails = { minMarginPercent: 10, neverBelowCost: false };
    expect(floorsApplying(unconfirmed, STORE, "USD")).toMatchObject({ minMarginPercent: 25, neverBelowCost: true });

    // Confirmed: the campaign's own, and none where it set none.
    const confirmed: CampaignGuardrails = {
      minMarginPercent: null,
      neverBelowCost: false,
      loosened: { floors: ["minMarginPercent", "neverBelowCost"], by: "staff:91614707946", at: "2026-11-01T10:00:00.000Z" },
    };
    expect(floorsApplying(confirmed, STORE, "USD")).toMatchObject({ minMarginPercent: undefined, neverBelowCost: false, minPrice: usd(500) });
  });

  it("prices a variant at the campaign's tighter floor, through the resolver itself", () => {
    const sale: ResolvableCampaign = {
      id: "c1",
      priority: 100,
      startAt: 1,
      ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -20 } }],
      compareAtPolicy: { kind: "leave" },
      compareAtViolationPolicy: "clear",
      roundingPolicy: policyOf(NO_ROUNDING),
      guardrails: resolverGuardrails({ minPrice: usd(9_500) }),
      guardrailViolationPolicy: "clamp",
    };
    const baseline = { price: usd(10_000) };
    const surface = { kind: "base" as const, currency: "USD" };
    expect(resolve({ baseline, surface, campaigns: [sale], storeGuardrails: { minPrice: usd(500) } }).price).toEqual(usd(9_500));
    expect(resolve({ baseline, surface, campaigns: [{ ...sale, guardrailViolationPolicy: "skip" }], storeGuardrails: {} }).meta).toMatchObject({
      outcome: "skipped",
      reason: "below-floor",
    });
    expect(resolve({ baseline, surface, campaigns: [{ ...sale, guardrailViolationPolicy: "block" }] }).meta.outcome).toBe("blocked");
    // On a market in euros its dollar minimum is not applied, as the store's is not (#691).
    expect(resolve({ baseline: { price: money(10_000, "EUR") }, surface: { kind: "market", currency: "EUR" }, campaigns: [sale] }).price).toEqual(
      money(8_000, "EUR"),
    );
  });
});

describe("which floors still need the word", () => {
  const confirmed: CampaignGuardrails = {
    minMarginPercent: 10,
    loosened: { floors: ["minMarginPercent"], by: "staff:91614707946", at: "2026-11-01T10:00:00.000Z" },
  };

  it("is every floor below the store's on a new campaign", () => {
    expect(stillToConfirm({ minMarginPercent: 10 }, ["minMarginPercent"], {})).toEqual(["minMarginPercent"]);
  });

  it("is none on a save that leaves a confirmed floor where it was, or raises it", () => {
    expect(stillToConfirm({ minMarginPercent: 10, minPrice: usd(900) }, ["minMarginPercent"], confirmed)).toEqual([]);
    expect(stillToConfirm({ minMarginPercent: 15 }, ["minMarginPercent"], confirmed)).toEqual([]);
  });

  it("is a confirmed floor taken further down, and any floor newly below", () => {
    expect(stillToConfirm({ minMarginPercent: 5 }, ["minMarginPercent"], confirmed)).toEqual(["minMarginPercent"]);
    expect(stillToConfirm({ minMarginPercent: null }, ["minMarginPercent"], confirmed)).toEqual(["minMarginPercent"]);
    expect(stillToConfirm({ minMarginPercent: 10, neverBelowCost: false }, ["minMarginPercent", "neverBelowCost"], confirmed)).toEqual([
      "neverBelowCost",
    ]);
  });

  it("is asked in one sentence, and answered by the word only", () => {
    expect(looseningAsk(["minMarginPercent", "neverBelowCost"], { minMarginPercent: 10, neverBelowCost: false }, STORE)).toBe(
      "This goes below the store's floors: minimum margin 10% (the store's is 25%) and never price at or below cost off " +
        "(the store's is on). Prices can then be written lower than Settings allows, for this campaign only. Type loosen to " +
        "confirm it. Your name and what it went below are recorded in the activity log.",
    );
    expect(typedLoosen(" Loosen ")).toBe(true);
    expect(typedLoosen("apply")).toBe(false);
    expect(typedLoosen(null)).toBe(false);
  });
});

describe("how the floors that apply are said", () => {
  it("names the store's when the campaign sets none", () => {
    expect(floorsView({}, STORE, "USD", "Europe/London")).toEqual({
      applied: "Never at or below cost, at least 25% margin and at least $5.00",
      whose: "The store's floors, from Settings.",
      unconfirmed: null,
    });
    expect(describeFloors({})).toBe("None: no floor applies, only that a price stays above zero");
  });

  it("names the campaign's own, tighter or confirmed below, with who confirmed it", () => {
    const view = floorsView(
      {
        minPrice: usd(1_000),
        minMarginPercent: 10,
        loosened: { floors: ["minMarginPercent"], by: "staff:91614707946", at: "2026-11-01T10:00:00.000Z" },
      },
      STORE,
      "USD",
      "Europe/London",
    );
    expect(view.applied).toBe("Never at or below cost, at least 10% margin and at least $10.00");
    expect(view.whose).toMatch(/^This campaign's own minimum price \$10\.00 \(the store's is \$5\.00\), tighter than the store's\. /);
    expect(view.whose).toContain("This campaign's own minimum margin 10% (the store's is 25%), below the store's, confirmed by Staff 7946 on");
    expect(view.whose).toMatch(/The rest are the store's, from Settings\.$/);
    expect(view.unconfirmed).toBeNull();
  });

  it("says a floor below the store's nobody confirmed is not applied", () => {
    expect(floorsView({ minMarginPercent: 10 }, STORE, "USD", "UTC").unconfirmed).toBe(
      "This campaign's own minimum margin 10% (the store's is 25%) is below the store's, and nobody has confirmed that for " +
        "this campaign, so the store's applies. To use its own instead, set it again below and type loosen.",
    );
  });

  it("says what a draft's preview was worked out with, and what Create will ask", () => {
    expect(draftFloorsView({ minMarginPercent: 10 }, ["minMarginPercent"], STORE, "USD")).toEqual({
      applied: "Never at or below cost, at least 10% margin and at least $5.00",
      whose: "The rest are the store's, from Settings.",
      below: "Below the store's: minimum margin 10% (the store's is 25%). Create asks you to type loosen to confirm it.",
    });
  });
});

describe("what the fields show", () => {
  it("is the floors that apply, so a save left untouched changes nothing", () => {
    expect(floorFieldsOf({}, STORE, "USD")).toEqual({ neverBelowCost: true, minMarginPercent: "25", minPrice: "5.00", policy: "" });
    expect(floorsFromForm(posted(), "USD", STORE)).toEqual({ ok: true, floors: {}, below: [] });
    // A floor below the store's nobody confirmed shows the store's, which is what applies.
    expect(floorFieldsOf({ minMarginPercent: 10, violationPolicy: "skip" }, STORE, "USD")).toMatchObject({ minMarginPercent: "25", policy: "skip" });
  });

  it("is what the full preview's link carries back, blank and unticked included", () => {
    const store = floorFieldsOf({}, STORE, "USD");
    expect(floorFieldsFrom(new URLSearchParams(), store)).toBe(store);
    expect(floorFieldsFrom(new URLSearchParams({ floors: "1", floorMinPrice: "7.00", breachPolicy: "block" }), store)).toEqual({
      neverBelowCost: false,
      minMarginPercent: "",
      minPrice: "7.00",
      policy: "block",
    });
  });
});

describe("what is stored and logged", () => {
  it("reads back only what it recognises", () => {
    expect(
      campaignGuardrailsOf({
        neverBelowCost: "yes",
        minMarginPercent: 150,
        minPrice: { amount: 1.5, currency: "USD" },
        violationPolicy: "sometimes",
        loosened: { floors: ["minPrice", "nonsense"], by: "x", at: "2026-11-01T10:00:00.000Z" },
      }),
    ).toEqual({ loosened: { floors: ["minPrice"], by: "x", at: "2026-11-01T10:00:00.000Z" } });
  });

  it("puts each floor in an audit entry as one flat key, a price with its currency", () => {
    expect(floorsAudit({ minPrice: usd(1_250), violationPolicy: "block" })).toEqual({
      minPrice: { minor: "1250", currency: "USD" },
      violationPolicy: "block",
    });
    expect(floorsAudit(STORE, ["minMarginPercent", "neverBelowCost"])).toEqual({ minMarginPercent: 25, neverBelowCost: true });
    expect(floorsAudit({ minMarginPercent: null }, ["minMarginPercent"])).toEqual({ minMarginPercent: null });
  });

  it("compares a price in another currency than the store's with nothing", () => {
    expect(belowStore({ minPrice: money(100, "EUR") }, STORE)).toEqual([]);
  });
});
