import { DRAFT_DEFAULTS } from "./draft-defaults";

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
  /** Rounding from the URL, where it carries any; otherwise the store's setting stands. */
  rounding: { default?: string; byCurrency: Record<string, string> };
}

const KINDS = new Set(["percent-change", "fixed-change", "set-exact", "from-file"]);
const COMPARE_AT = new Set(["set-to-baseline", "leave", "clear"]);

export function editorRuleFrom(params: URLSearchParams): EditorRule {
  const requested = params.get("ruleKind") ?? "";
  const kind = KINDS.has(requested) ? requested : DRAFT_DEFAULTS.ruleKind;
  const money = kind === "fixed-change" || kind === "set-exact";

  const raw = Number(params.get("ruleValue") ?? "");
  const given = params.get("ruleValue")?.trim() && Number.isFinite(raw);
  const said = params.get("ruleDirection");
  const direction: "down" | "up" = said === "up" || said === "down" ? said : given && raw > 0 ? "up" : "down";
  const magnitude = given
    ? String(kind === "set-exact" ? raw : Math.abs(raw))
    : kind === "set-exact"
      ? ""
      : money
        ? DRAFT_DEFAULTS.fixedMagnitude
        : DRAFT_DEFAULTS.percentMagnitude;

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
    rounding: { default: params.get("rounding.default") || undefined, byCurrency },
  };
}
