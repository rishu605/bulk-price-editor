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

import { abs, negate, type Money } from "../money/money";
import { typedAmount } from "../money/typed-amount";
import type { AdjustmentRule, CompareAtPolicy, CompareAtViolationPolicy } from "../pricing/types";
import type { FilterAst } from "../../services/segments.server";
import { PRODUCT_STATUS_FIELDS, productStatusesOf, type ProductStatus } from "./product-status";
import { reductionProblem } from "./rule-limits";

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

/** The field a rule's amount is typed into, as the refusals name it. */
function fieldOf(kind: string): string {
  if (kind === "set-exact") return "The exact price";
  if (kind === "fixed-change") return "The amount to change by";
  if (kind === "from-cost-multiplier") return "The markup";
  if (kind === "from-cost-margin") return "The margin";
  return "The percentage";
}

/**
 * The rules that price from something other than the baseline price (#817, PRD A-3.1): cost
 * and a markup, cost at a margin, and a percentage off the compare-at. The engine has priced
 * them since P2, and no screen offered them. A variant without the cost or compare-at they
 * read keeps its price, said on its row (`needs-cost`, `needs-compare-at`), never priced as
 * though the missing amount were zero.
 */
export const FROM_COST_MULTIPLIER = "from-cost-multiplier";
export const FROM_COST_MARGIN = "from-cost-margin";
export const OFF_COMPARE_AT = "percent-of-compare-at";

/**
 * The largest markup the form takes. A hundred times cost is not a price anybody means: it
 * is a cost typed where the markup goes, and the preview would show every price at it.
 */
export const MAX_MARKUP = 100;

/** Why a rule that is not a change from the baseline cannot be used, or null (#817). */
function fromOtherProblem(kind: string, amount: number, field: string): string | null {
  if (kind === FROM_COST_MULTIPLIER) {
    if (amount <= 0) return `${field} has to be more than 0. Enter how many times cost to charge, such as 2.`;
    return amount >= MAX_MARKUP ? `${field} of ${amount} times cost is not a price. Enter less than ${MAX_MARKUP}.` : null;
  }
  if (kind === FROM_COST_MARGIN) {
    if (amount <= 0) return `${field} has to be more than 0%: at 0% or less every price is at or below cost.`;
    return amount >= 100 ? `A margin of ${amount}% would need an infinite price, since margin is a share of the selling price. Enter less than 100.` : null;
  }
  // Off the compare-at: a reduction, as "Reduce by" is, and held to the same limit (#818).
  return amount === 0 ? `${field} is 0, which would price every variant at its compare-at. Enter the percentage off.` : reductionProblem(-Math.abs(amount));
}

/**
 * A money rule's amount in minor units, read from the text (#1068), or why it cannot be.
 *
 * `10 ** decimalsFor(currency)` replaced a literal 100 here once (#343): a hundred read a
 * ¥3,000 price as ¥300,000. It still multiplied a float, so 9.995 dollars became
 * `Math.round(999.4999999999999)` and saved 9.99, while 4.355 saved 4.36. The text is read
 * as text now, and more decimals than the currency has is refused, never rounded.
 */
function typedRuleAmount(read: FieldReader, kind: string, currency: string) {
  return typedAmount(fieldOf(kind), read("ruleValue") ?? "", currency);
}

/** A fixed change's amount, signed by the direction when there is one, as `signedAmount`. */
function directed(amount: Money, direction: string | null): Money {
  if (direction !== "up" && direction !== "down") return amount;
  return direction === "up" ? abs(amount) : negate(abs(amount));
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
 *
 * The currency is the shop's, because whether 9.995 is a price depends on it (#1068): it
 * is three decimals too many for dollars, and 1.005 is exactly right for dinar.
 */
export function ruleInputProblem(read: FieldReader, currency: string): string | null {
  const kind = read("ruleKind") ?? "percent-change";
  const raw = (read("ruleValue") ?? "").trim();
  const field = fieldOf(kind);

  if (raw === "") return `${field} is empty. Enter a number.`;
  if (!Number.isFinite(Number(raw))) {
    return raw.includes(",")
      ? `${field} "${raw}" is not a number. Use a full stop for decimals, as in ${raw.replace(",", ".")}.`
      : `${field} "${raw}" is not a number.`;
  }

  if (kind === "set-exact" || kind === "fixed-change") {
    const typed = typedRuleAmount(read, kind, currency);
    if (!typed.ok) return typed.message;
    if (kind === "set-exact") {
      return typed.amount.amount > 0 ? null : "An exact price has to be more than zero. Enter the price to set.";
    }
  }

  if (kind === FROM_COST_MULTIPLIER || kind === FROM_COST_MARGIN || kind === OFF_COMPARE_AT) {
    return fromOtherProblem(kind, Number(raw), field);
  }

  const signed = signedAmount(read);
  if (signed === 0) return `${field} is 0, which would leave every price where it is. Enter the change to make.`;
  // The same limit the run holds a stored campaign to (#818), so the form cannot save a
  // rule the Apply would then refuse.
  return kind === "percent-change" ? reductionProblem(signed) : null;
}

/**
 * The rule the merchant has described.
 *
 * Callers ask `ruleInputProblem` first and show its sentence. An amount it would refuse
 * throws here with the same sentence rather than being rounded into a price nobody typed.
 *
 * @throws {RangeError} for a money amount the currency cannot hold.
 */
export function ruleFrom(read: FieldReader, currency: string): AdjustmentRule {
  const kind = read("ruleKind") ?? "percent-change";

  if (kind === "fixed-change" || kind === "set-exact") {
    const typed = typedRuleAmount(read, kind, currency);
    if (!typed.ok) throw new RangeError(typed.message);
    // An exact price has no direction — it is not a change, so a sign would be a
    // negative price. The typed value is right here, and the editor renders no direction
    // control for it.
    return kind === "set-exact"
      ? { kind: "set-exact", amount: typed.amount }
      : { kind: "fixed-change", amount: directed(typed.amount, read("ruleDirection")) };
  }
  // From cost, or off the compare-at (#817). The amount as typed: a markup and a margin have
  // no direction, and a percentage off the compare-at only ever takes off.
  const amount = Number(read("ruleValue") ?? 0);
  if (kind === FROM_COST_MULTIPLIER) return { kind: FROM_COST_MULTIPLIER, factor: amount };
  if (kind === FROM_COST_MARGIN) return { kind: FROM_COST_MARGIN, marginPercent: amount };
  if (kind === OFF_COMPARE_AT) return { kind: OFF_COMPARE_AT, percent: -Math.abs(amount) || 0 };
  return { kind: "percent-change", percent: signedAmount(read) };
}

export function compareAtFrom(read: FieldReader): CompareAtPolicy {
  const value = read("compareAt") ?? "leave";
  if (value === "set-to-baseline") return { kind: "set-to-baseline" };
  if (value === "clear") return { kind: "clear" };
  return { kind: "leave" };
}

/**
 * What a campaign does when the compare-at it would write is not above the new price (#817,
 * PRD A-3.3): drop the strike-through, leave the variant at its price, or stop the campaign.
 * Dropping it is what every campaign did before the choice existed (`createCampaign` wrote
 * "clear"), so a form that does not say is read as that.
 */
export function compareAtViolationFrom(read: FieldReader): CompareAtViolationPolicy {
  const value = read("compareAtViolation");
  return value === "skip" || value === "block" ? value : "clear";
}

/** The inline filter, as an AST. An empty filter is every variant, not none. */
export function astFrom(read: FieldReader): FilterAst {
  const conditions = SCOPE_CONDITION_FIELDS.map((field) => [field, read(field)] as const)
    .filter(([, value]) => value && value.trim().length > 0)
    .map(([field, value]) => ({ field, value: value!.trim() }));

  return conditions.length > 0 ? { groups: [{ conditions }] } : { groups: [] };
}

/**
 * The product statuses the form covers: active always, draft and archived when ticked
 * (#751).
 *
 * Its own reader rather than part of `astFrom`, because a saved segment replaces the
 * filter and not this: a campaign on a segment still chooses which of its products the
 * sale reaches. The live preview and the create action both read it here, so a box ticked
 * in the editor is a box the preview prices and the campaign keeps -- rule 4 again, on
 * the inputs.
 *
 * Ticked is present and non-empty, which is how a checkbox posts and how the full
 * preview's link carries it back.
 */
export function productStatusesFrom(read: FieldReader): ProductStatus[] {
  const ticked = Object.entries(PRODUCT_STATUS_FIELDS)
    .filter(([field]) => (read(field) ?? "").trim() !== "")
    .map(([, status]) => status);
  return productStatusesOf(["ACTIVE", ...ticked]);
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
