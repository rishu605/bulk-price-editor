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
export const SCOPE_CONDITION_FIELDS = [
  "collection",
  "tag",
  // The exception, and it has to be here rather than only in the create action: the
  // preview reads this list, and a scope a merchant can set but not see previewed is
  // worse than one they cannot set — rule 4 says preview and execution share one path.
  "excludeTag",
  "vendor",
  "title",
] as const;

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
/**
 * Which way a change goes, asked as a direction rather than as a minus sign.
 *
 * To take 20% off, a merchant used to type `-20` into a field labelled "Percentage",
 * under a line of help reading "Negative discounts. -20 means 20% off the baseline." It
 * is the first control in the create flow, so the sign convention was the first thing the
 * product taught — and a merchant who typed `20`, which is what "20% off" sounds like,
 * got a twenty per cent price *rise* with nothing on the screen refusing it.
 *
 * The magnitude is read as an absolute value once a direction is present, so the two
 * halves cannot disagree: a merchant who chooses "Reduce by" and types `-20` gets 20% off
 * rather than 20% on.
 *
 * ## Why the absent case still means what it used to
 *
 * `ruleDirection` is only sent by the editor's form. Quick create on Home,
 * `draftDefaultParams`, and the four old import URLs all pass a signed `ruleValue` and no
 * direction, and a bookmarked `?ruleValue=-20` has to keep meaning what it meant. So the
 * signed value is used exactly as given when no direction is present, and this reads as
 * two spellings of one thing rather than as a migration.
 */
export type RuleDirection = "up" | "down";

function signedAmount(read: FieldReader): number {
  const amount = Number(read("ruleValue") ?? 0);
  const direction = read("ruleDirection");

  if (direction !== "up" && direction !== "down") return amount;

  const magnitude = Math.abs(amount);
  // `|| 0` collapses `-0`, which `-Math.abs(0)` produces and which is a different value
  // to `0` for anything comparing rules — including the test that asserts these two
  // spellings agree. Nothing downstream means anything by the sign of zero.
  return (direction === "up" ? magnitude : -magnitude) || 0;
}

export function ruleFrom(read: FieldReader, currency: string): AdjustmentRule {
  const kind = read("ruleKind") ?? "percent-change";
  const perMajor = 10 ** decimalsFor(currency);

  if (kind === "fixed-change") {
    return {
      kind: "fixed-change",
      amount: money(Math.round(signedAmount(read) * perMajor), currency),
    };
  }
  if (kind === "set-exact") {
    // An exact price has no direction — it is not a change, so a sign would be a
    // negative price. The raw value is right here, and the editor renders no direction
    // control for it.
    const amount = Number(read("ruleValue") ?? 0);
    return { kind: "set-exact", amount: money(Math.round(amount * perMajor), currency) };
  }
  return { kind: "percent-change", percent: signedAmount(read) };
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
