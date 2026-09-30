/**
 * Whether guided mode keeps the promise its own banner makes.
 *
 * The third checklist step is "Run your first real campaign", its teaching reads "Start
 * small — five products is plenty", and its button opens `/app/campaigns/new?guided=1`.
 * That page said the same thing — "narrow the scope to a handful of products" — and
 * defaulted the scope to **everything**: on `dartmode-labs` the preview opened on "3,669
 * of 3,669 variants would change price".
 *
 * So a first-time merchant pressing the obvious button got a whole-catalogue sale,
 * having just been told they were doing a small one. `GUIDED_PRODUCT_LIMIT` had been
 * sitting in `steps.ts` since the flow was written and nothing read it.
 *
 * The rule is tested directly. Its wiring is checked against the source, because this
 * route cannot be rendered here without a data router and a DOM that knows Polaris's
 * form fields.
 */

import { describe, expect, it } from "vitest";

import { GUIDED_PRODUCT_LIMIT } from "./steps";
import { NARROWING_FIELDS, scopeChosen } from "./guided-scope";
import { readerFor, SCOPE_CONDITION_FIELDS } from "../campaigns/draft-form";
import { sourceOf } from "../testing/source";

const EDITOR = sourceOf("app/routes/app.campaigns.new.tsx");
const STEPS = sourceOf("app/lib/onboarding/steps.ts");

describe("the promise", () => {
  it("is made with the constant rather than a number typed twice", () => {
    // The banner said "five is plenty" in prose while the constant said 5 in code, so
    // changing one would have left the other saying something else.
    expect(EDITOR).toContain("{GUIDED_PRODUCT_LIMIT} is plenty");
  });

  it("is still the number the checklist teaches", () => {
    expect(GUIDED_PRODUCT_LIMIT).toBe(5);
    expect(STEPS).toContain("five products is plenty");
  });
});

describe("the gate", () => {
  it("reads the scope through the one rule, wherever the scope is", () => {
    // The URL for the first render, the form as it changes, the submitted form on the
    // server. The loader-only version never saw a pick: since #442 the scope posts with
    // the rest of the form and never reaches the URL (#715).
    expect(EDITOR).toContain("guidedNeedsScope: guided && !scopeChosen(readerFor(url.searchParams))");
    expect(EDITOR).toContain("setScoped(scopeChosen(readerFor(new FormData(formRef.current))))");
    expect(EDITOR).toMatch(/form\.get\("guided"\).*=== "1" && !scopeChosen\(readerFor\(form\)\)/);
  });

  it("re-reads the scope on every change to the form, heard natively", () => {
    // React's `<Form onChange>` never fires for Polaris fields: their events reach the form
    // as native events from a custom element, which React does not turn into an ancestor
    // `onChange`. Measured in the admin: change=1, input=2, React onChange=0 (#863).
    expect(EDITOR).toContain('form.addEventListener("input", changed);');
    expect(EDITOR).toContain('form.addEventListener("change", changed);');
    expect(EDITOR).toContain("const changed = () => latestFormChanged.current();");
    expect(EDITOR).not.toMatch(/<Form[^>]*\bon(Change|Input)=/);
    expect(EDITOR).toContain('<input type="hidden" name="guided" value={guided ? "1" : ""} />');
  });

  it("stops the submit rather than refusing after it", () => {
    // Telling a merchant their first campaign was too big, after they pressed the
    // button, is telling them too late.
    expect(EDITOR).toContain("disabled={needsScope || undefined}");
    expect(EDITOR).not.toContain("disabled={guidedNeedsScope");
  });

  it("says what to do, not merely that something is missing", () => {
    expect(EDITOR).toContain("Pick a collection, a vendor, a tag or a title");
  });
});

describe("what the gate must not do", () => {
  it("leaves an ordinary campaign alone", () => {
    // Only guided mode promises small. The full editor is for merchants who know what
    // they are doing, and a whole-catalogue sale is a legitimate thing to want.
    expect(EDITOR).toContain("guidedNeedsScope: guided &&");
    expect(EDITOR).toContain("const needsScope = guided &&");
  });

  it("leaves practice mode alone", () => {
    // Practice writes nothing, so scope size costs nothing but time.
    expect(EDITOR).not.toContain("practice && guidedNeedsScope");
    expect(EDITOR).not.toContain("practice && needsScope");
  });
});

describe("whether the scope has been narrowed (#715)", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return readerFor(data);
  };

  it("is not, on the empty form the guided page opens with", () => {
    expect(scopeChosen(form({ name: "Summer", value: "-20", collection: "", vendor: "", tag: "", title: "" }))).toBe(
      false,
    );
  });

  it("is, once a vendor is picked -- the pick that never enabled the button", () => {
    expect(scopeChosen(form({ vendor: "Cascade" }))).toBe(true);
  });

  it("is, by any one narrowing field or a saved segment", () => {
    for (const field of NARROWING_FIELDS) expect(scopeChosen(form({ [field]: "x" })), field).toBe(true);
  });

  it("is not by excluding a tag, which still leaves nearly everything", () => {
    expect(scopeChosen(form({ excludeTag: "clearance" }))).toBe(false);
  });

  it("is not by whitespace", () => {
    expect(scopeChosen(form({ title: "   " }))).toBe(false);
  });

  it("reads a query string the same way, for the first render", () => {
    expect(scopeChosen(readerFor(new URLSearchParams("guided=1&tag=summer")))).toBe(true);
    expect(scopeChosen(readerFor(new URLSearchParams("guided=1")))).toBe(false);
  });

  it("counts every condition field the editor offers except the exclusion", () => {
    // A field added to the editor narrows here without anyone remembering to add it.
    expect([...NARROWING_FIELDS].sort()).toEqual(
      [...SCOPE_CONDITION_FIELDS.filter((field) => field !== "excludeTag"), "segment"].sort(),
    );
  });
});
