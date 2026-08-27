/**
 * Turning the campaign editor's form into the rule and scope a campaign is made of.
 *
 * Extracted so the live preview and the create action cannot build a different campaign
 * from the same fields. Rule 4 says preview and execution share one code path; a
 * preview that parsed `-20` into a different rule than the submit would honour the
 * letter of that and none of the point.
 *
 * The currency is a parameter rather than a form field read with a default. It used to
 * be `String(form.get("currency") ?? "USD")` against a form that has no currency field,
 * so every fixed-amount rule on every store was built in USD (#343). Making the caller
 * supply it means there is no default left to be silently wrong.
 */

import { decimalsFor } from "../money/format";
import { money } from "../money/money";
import type { AdjustmentRule, CompareAtPolicy } from "../pricing/types";
import type { FilterAst } from "../../services/segments.server";

/** Scope fields the editor offers, minus `segment`, which resolves to a whole AST. */
export const SCOPE_CONDITION_FIELDS = ["collection", "tag", "vendor", "title"] as const;

/** Reads a value from either a form or a query string, so one parser serves both. */
export type FieldReader = (name: string) => string | null;

export function readerFor(source: FormData | URLSearchParams): FieldReader {
  return (name) => {
    const value = source.get(name);
    return typeof value === "string" ? value : null;
  };
}

/**
 * The rule the merchant has described.
 *
 * `10 ** decimalsFor(currency)` rather than a literal 100: a hardcoded hundred reads a
 * ¥3,000 price as ¥300,000 and a 1.5 KWD price as 0.15 KWD. The same literal has been
 * removed from three service files already.
 */
export function ruleFrom(read: FieldReader, currency: string): AdjustmentRule {
  const kind = read("ruleKind") ?? "percent-change";
  const amount = Number(read("ruleValue") ?? 0);
  const perMajor = 10 ** decimalsFor(currency);

  if (kind === "fixed-change") {
    return { kind: "fixed-change", amount: money(Math.round(amount * perMajor), currency) };
  }
  if (kind === "set-exact") {
    return { kind: "set-exact", amount: money(Math.round(amount * perMajor), currency) };
  }
  return { kind: "percent-change", percent: amount };
}

export function compareAtFrom(read: FieldReader): CompareAtPolicy {
  const value = read("compareAt") ?? "leave";
  if (value === "set-to-baseline") return { kind: "set-to-baseline" };
  if (value === "clear") return { kind: "clear" };
  return { kind: "leave" };
}

/** The inline filter, as an AST. An empty filter is every variant, not none. */
export function astFrom(read: FieldReader): FilterAst {
  const conditions = SCOPE_CONDITION_FIELDS.map((field) => [field, read(field)] as const)
    .filter(([, value]) => value && value.trim().length > 0)
    .map(([field, value]) => ({ field, value: value!.trim() }));

  return conditions.length > 0 ? { groups: [{ conditions }] } : { groups: [] };
}
