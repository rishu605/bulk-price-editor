/**
 * The editor's fields render the rule the link carried, so the form and its first preview
 * describe the same campaign (#718, #771).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RuleValueField } from "../../components/RuleValueField";
import { compareAtFrom, readerFor, ruleFrom, ruleInputProblem } from "./draft-form";
import { editorRuleFrom } from "./editor-rule";
import { firstPreviewParams } from "./first-preview";
import { moreOptionsHref } from "./quick-campaign";
import { sourceOf } from "../testing/source";

const params = (query: string) => new URLSearchParams(query);

describe("reading the rule a link carries", () => {
  it("is the editor's defaults with no rule in the URL", () => {
    expect(editorRuleFrom(params(""))).toMatchObject({ kind: "percent-change", direction: "down", magnitude: "20", compareAt: "set-to-baseline" });
  });

  it("reads a magnitude with a direction, as the form posts it", () => {
    expect(editorRuleFrom(params("ruleValue=35&ruleDirection=down"))).toMatchObject({ direction: "down", magnitude: "35" });
    expect(editorRuleFrom(params("ruleValue=10&ruleDirection=up"))).toMatchObject({ direction: "up", magnitude: "10" });
  });

  it("reads a signed value as older links and quick create send it", () => {
    expect(editorRuleFrom(params("ruleValue=-35"))).toMatchObject({ direction: "down", magnitude: "35" });
    expect(editorRuleFrom(params("ruleValue=12"))).toMatchObject({ direction: "up", magnitude: "12" });
  });

  it("keeps an exact price as the price, and ignores a kind it does not know", () => {
    expect(editorRuleFrom(params("ruleKind=set-exact&ruleValue=19.99"))).toMatchObject({ kind: "set-exact", magnitude: "19.99" });
    expect(editorRuleFrom(params("ruleKind=bogus")).kind).toBe("percent-change");
  });

  it("reads compare-at and rounding, and nothing it does not recognise", () => {
    const rule = editorRuleFrom(params("compareAt=leave&rounding.default=charm-99&rounding.JPY=whole"));
    expect(rule.compareAt).toBe("leave");
    expect(rule.rounding).toEqual({ default: "charm-99", byCurrency: { JPY: "whole" } });
    expect(editorRuleFrom(params("compareAt=nonsense")).compareAt).toBe("set-to-baseline");
  });
});

describe("back from the full preview (#718)", () => {
  it.each([
    "ruleKind=percent-change&ruleValue=35&ruleDirection=down&compareAt=leave",
    "ruleValue=-35&compareAt=leave",
  ])("the rendered fields and the first preview agree: %s", (query) => {
    // What the first preview prices: the URL over the defaults.
    const preview = readerFor(firstPreviewParams({ default: "none", byCurrency: {} }, params(query)));
    expect(ruleFrom(preview, "USD")).toEqual({ kind: "percent-change", percent: -35 });
    expect(compareAtFrom(preview)).toEqual({ kind: "leave" });

    // What the form renders from the same URL.
    const rule = editorRuleFrom(params(query));
    expect(rule.compareAt).toBe("leave");
    const html = renderToStaticMarkup(
      <RuleValueField currency="USD" kind={rule.kind} onKindChange={() => {}} initial={rule} />,
    );
    expect(html, "the form still shows the default 20").toContain('value="35"');
    expect(html).toMatch(/<s-option value="down" default-?selected/i);
  });
});

describe("the editor renders every rule field from the link (#718)", () => {
  const editor = sourceOf("app/routes/app.campaigns.new.tsx");

  it("passes the link's amount and direction to the rule field", () => {
    expect(editor).toMatch(/initial=\{ruleKind === initialRule\.kind \? initialRule : undefined\}/);
  });

  it("selects the link's compare-at and rounding, not fixed defaults", () => {
    expect(editor).toContain('defaultSelected={initialRule.compareAt === "leave"}');
    expect(editor).not.toMatch(/value="set-to-baseline" defaultSelected>/);
    expect(editor).toContain("defaultSelected={option.value === formRounding.default}");
  });
});

describe("Home's 'Or set a scope, a schedule and more' (#771)", () => {
  it("opens the editor at the % typed on Home", () => {
    expect(moreOptionsHref("35")).toBe("/app/campaigns/new?ruleKind=percent-change&ruleDirection=down&ruleValue=35");
    expect(editorRuleFrom(new URL(`https://x${moreOptionsHref("35")}`).searchParams)).toMatchObject({ direction: "down", magnitude: "35" });
  });

  it("opens it at its defaults when nothing usable was typed", () => {
    expect(moreOptionsHref("")).toBe("/app/campaigns/new");
    expect(moreOptionsHref("150")).toBe("/app/campaigns/new");
  });

  it("is built from the field, not a fixed link", () => {
    const home = sourceOf("app/routes/app._index.tsx");
    expect(home).toContain("moreOptionsHref(");
    expect(home).not.toMatch(/href="\/app\/campaigns\/new">\s*Or set a scope/);
  });
});

describe("Reduce by is capped below 100% in the form (#818)", () => {
  const field = (direction: "down" | "up", kind = "percent-change") =>
    renderToStaticMarkup(
      <RuleValueField currency="USD" kind={kind} onKindChange={() => {}} initial={{ direction, magnitude: "20" }} />,
    );

  it("gives the percentage a max just under 100 while it reduces", () => {
    expect(field("down")).toMatch(/<s-number-field[^>]*max="99.99"/);
    expect(field("down")).toContain("Less than 100.");
  });

  it("leaves an increase uncapped: a 150% rise is a real rule", () => {
    expect(field("up")).not.toMatch(/<s-number-field[^>]*max=/);
  });

  it("refuses at the boundary what the cap stops, for anything typed past it", () => {
    const read = (ruleValue: string) =>
      readerFor(new URLSearchParams({ ruleKind: "percent-change", ruleValue, ruleDirection: "down" }));
    expect(ruleInputProblem(read("99.99"), "USD")).toBeNull();
    expect(ruleInputProblem(read("100"), "USD")).toMatch(/^A 100% reduction would make every price free or negative/);
    expect(ruleInputProblem(read("150"), "USD")).toMatch(/^A 150% reduction/);
  });
});
