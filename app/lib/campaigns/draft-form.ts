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

/**
 * Why the rule's amount cannot be used, naming the field, or null when it can (#696).
 *
 * `Number("")` is 0, so an exact price left blank saved a campaign setting every price to
 * 0.00, which the resolver then clamped to one minor unit: the whole scope previewed, and
 * would have applied, at 0.01, reported as "below your floor". A reduction of 150% did the
 * same. A decimal comma ("1,5", the usual spelling across most of Europe) reached `money()`
 * as NaN and threw as an unclassified error. Each is refused here, before anything is
 * priced or saved, in words the merchant can act on.
 */
export function ruleInputProblem(read: FieldReader): string | null {
  const kind = read("ruleKind") ?? "percent-change";
  const raw = (read("ruleValue") ?? "").trim();
  const field =
    kind === "set-exact" ? "The exact price" : kind === "fixed-change" ? "The amount to change by" : "The percentage";

  if (raw === "") return `${field} is empty. Enter a number.`;
  if (!Number.isFinite(Number(raw))) {
    return raw.includes(",")
      ? `${field} "${raw}" is not a number. Use a full stop for decimals, as in ${raw.replace(",", ".")}.`
      : `${field} "${raw}" is not a number.`;
  }

  if (kind === "set-exact") {
    return Number(raw) > 0 ? null : "An exact price has to be more than zero. Enter the price to set.";
  }

  const signed = signedAmount(read);
  if (signed === 0) return `${field} is 0, which would leave every price where it is. Enter the change to make.`;
  if (kind === "percent-change" && signed <= -100) {
    return `A ${Math.abs(signed)}% reduction would make every price free or negative. Enter less than 100.`;
  }
  return null;
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

/** What a campaign's priority is when the field is left empty. */
export const DEFAULT_PRIORITY = 100;
/** How many minutes before a window ends its prices come back, when the field is empty. */
export const DEFAULT_REVERT_BUFFER_MINUTES = 5;

/**
 * A whole number from the form, or `fallback` when the field is missing, blank or not a
 * number -- and only then (#727).
 *
 * Both fields were read as `Number(value) || default`, and `0 || 100` is `100`: a merchant
 * who typed priority 0 to make a campaign the lowest got 100, which outranked their
 * priority-50 campaign, so on the variants they share the wrong price won. A revert buffer
 * of 0 -- no early revert -- became five minutes.
 *
 * Whole, because both are stored as integers and Prisma refuses a fraction.
 */
export function wholeNumberOr(raw: string | null | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** A campaign's priority, read the same way by the preview and by the action that saves it. */
export function priorityFrom(read: FieldReader): number {
  return wholeNumberOr(read("priority"), DEFAULT_PRIORITY);
}

/** Minutes before a window's end that its prices revert; never negative. */
export function revertBufferFrom(read: FieldReader): number {
  return Math.max(0, wholeNumberOr(read("revertBuffer"), DEFAULT_REVERT_BUFFER_MINUTES));
}
