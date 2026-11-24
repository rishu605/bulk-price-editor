import { DRAFT_DEFAULTS } from "./draft-defaults";
import { asCompareAtViolation } from "./compare-at-violation";
import type { CompareAtViolationPolicy } from "../pricing/types";

/**
 * The rule the campaign editor's fields render, read from the URL that opened it (#718, #771).
 *
 * The first preview has always priced the URL's values (`firstPreviewParams`), but the fields
 * rendered the defaults: back from the full preview, the panel said 35% off with compare-at
 * left alone while the form beside it said 20% and Set to baseline, and Create made the 20%
 * one. Home's "Or set a scope, a schedule and more" had nothing to carry the % the merchant
 * typed into. Both now open the editor with a URL, and the fields render from this.
 *
 * Both spellings of an amount are read, as `draft-form.ts` reads them: a signed `ruleValue`
 * (-35 is 35% off), or a magnitude with `ruleDirection`.
 */

export interface EditorRule {
  kind: string;
  direction: "down" | "up";
  /** What the amount field shows: a magnitude for a change, the price for an exact one. */
  magnitude: string;
  compareAt: string;
  /** What a compare-at not above the price does (#817), so the link back keeps the choice. */
  compareAtViolation: CompareAtViolationPolicy;
  /** Rounding from the URL, where it carries any; otherwise the store's setting stands. */
  rounding: { default?: string; byCurrency: Record<string, string> };
}

// With the rules from cost and from the compare-at (#817), so the full preview's link back
// reopens the editor on the rule it previewed.
const KINDS = new Set(["percent-change", "fixed-change", "set-exact", "from-cost-multiplier", "from-cost-margin", "percent-of-compare-at", "from-file"]);

/** What a kind's amount field starts at when the link carries none. */
function defaultMagnitude(kind: string): string {
  if (kind === "set-exact") return "";
  if (kind === "fixed-change") return DRAFT_DEFAULTS.fixedMagnitude;
  if (kind === "from-cost-multiplier") return DRAFT_DEFAULTS.markup;
  if (kind === "from-cost-margin") return DRAFT_DEFAULTS.margin;
  if (kind === "percent-of-compare-at") return DRAFT_DEFAULTS.offCompareAt;
  return DRAFT_DEFAULTS.percentMagnitude;
}
const COMPARE_AT = new Set(["set-to-baseline", "leave", "clear"]);

export function editorRuleFrom(params: URLSearchParams): EditorRule {
  const requested = params.get("ruleKind") ?? "";
  const kind = KINDS.has(requested) ? requested : DRAFT_DEFAULTS.ruleKind;

  const raw = Number(params.get("ruleValue") ?? "");
  const given = params.get("ruleValue")?.trim() && Number.isFinite(raw);
  const said = params.get("ruleDirection");
  const direction: "down" | "up" = said === "up" || said === "down" ? said : given && raw > 0 ? "up" : "down";
  const magnitude = given ? String(kind === "set-exact" ? raw : Math.abs(raw)) : defaultMagnitude(kind);

  const compareAtRequested = params.get("compareAt") ?? "";
  const byCurrency: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key.startsWith("rounding.") && key !== "rounding.default" && value) byCurrency[key.slice("rounding.".length)] = value;
  }

  return {
    kind,
    direction,
    magnitude,
    compareAt: COMPARE_AT.has(compareAtRequested) ? compareAtRequested : DRAFT_DEFAULTS.compareAt,
    compareAtViolation: asCompareAtViolation(params.get("compareAtViolation")),
    rounding: { default: params.get("rounding.default") || undefined, byCurrency },
  };
}
