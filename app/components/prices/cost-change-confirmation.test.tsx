/**
 * The bulk cost change asks first, and says what it is about to do (#754).
 *
 * Two halves. The dialog, rendered: it names the count in its heading and on its button,
 * grouped, and restates the check rather than the form. And the page, read from source:
 * the amount starts empty, and the button beside the check opens this dialog instead of
 * committing — the shape that let one click raise 2,699 costs by a 4% nobody typed.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";
import { COST_CHANGE_MODAL_ID, CostChangeConfirmation, type CostCheck } from "./CostChangeConfirmation";

const check = (over: Partial<CostCheck> = {}): CostCheck => ({
  key: "{}",
  changed: 2699,
  matched: 3669,
  skipped: 0,
  rule: "Raise every matching cost by 4%",
  scope: "Every product",
  ...over,
});

const render = (value: CostCheck) =>
  renderToStaticMarkup(<CostChangeConfirmation check={value} onConfirm={() => {}} />);

describe("the confirmation", () => {
  it("asks with the count, grouped", () => {
    const html = render(check());

    expect(html).toContain('heading="Change 2,699 costs?"');
    expect(html).toContain("Change 2,699 costs</s-button>");
  });

  it("restates what was checked: the rule, the scope and the count", () => {
    const html = render(check({ scope: "Products from Acme" }));

    expect(html).toContain("Raise every matching cost by 4%");
    expect(html).toContain("Products from Acme");
    expect(html).toContain("2,699 of 3,669 variants");
  });

  it("accounts for the rest of the scope, and why when the rule could not reach them", () => {
    expect(render(check())).toContain("970 — already at that cost");
    expect(render(check({ skipped: 970 }))).toContain(
      "970 — 970 of them the rule could not work out a cost for",
    );
    // Every variant changing leaves nothing to account for, so the line is absent
    // rather than reading "0".
    expect(render(check({ changed: 3669 }))).not.toContain("Left as they are");
  });

  it("says what a cost moves, because nothing on the storefront will", () => {
    expect(render(check())).toMatch(/never-below-cost and minimum-margin floors/);
  });

  it("draws its commit in the one slot Polaris will render, marked as the one that writes", () => {
    const html = render(check());
    const commit = html.slice(html.indexOf('slot="primary-action"') - 200);

    expect(commit).toContain('variant="primary"');
    expect(commit).toContain('tone="critical"');
    expect(html).toContain(`commandFor="${COST_CHANGE_MODAL_ID}"`);
  });

  it("names a single cost in the singular", () => {
    expect(render(check({ changed: 1, matched: 1 }))).toContain('heading="Change 1 cost?"');
  });
});

describe("the bulk cost form", () => {
  const page = sourceOf("app", "routes", "app.prices.costs.tsx");
  const field = page.slice(page.indexOf('<s-number-field\n                name="value"'));
  const amount = field.slice(0, field.indexOf("/>"));

  it("finds the amount field, so the checks below cannot pass by reading nothing", () => {
    expect(amount).toContain('name="value"');
  });

  it("starts the amount empty and requires one", () => {
    // It opened at 4, which nobody typed.
    expect(amount).not.toMatch(/\bvalue=/);
    expect(amount).toMatch(/\brequired\b/);
  });

  it("opens the confirmation from the form rather than committing from it", () => {
    const button = page.slice(page.lastIndexOf("<s-button", page.indexOf("Change these costs")));
    const tag = button.slice(0, button.indexOf(">"));

    expect(tag).toContain("commandFor={COST_CHANGE_MODAL_ID}");
    expect(tag).toContain('command="--show"');
    expect(tag).toContain("disabled={!ready || undefined}");
    expect(tag).not.toContain("submitWith");
  });

  it("commits only from the confirmation", () => {
    expect(page.match(/submitWith\("commit"\)/g)).toHaveLength(1);
    expect(page).toMatch(/<CostChangeConfirmation[^>]*onConfirm=\{\(\) => submitWith\("commit"\)\}/);
  });

  it("posts the check the commit follows, for the action to hold it to", () => {
    expect(page).toContain('name="checked" value={check?.key ?? ""}');
    expect(page).toContain('name="expected" value={check?.changed ?? ""}');
  });
});
