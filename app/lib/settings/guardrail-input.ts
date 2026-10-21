/**
 * Checking the guardrail numbers a merchant typed, before any of them is saved (#739).
 *
 * `parseSettings` clamps whatever it is given into range, which is right for reading a
 * stored value and wrong for a save: "150" in Minimum margin was saved as 99.9 -- a floor
 * of a thousand times cost -- under "Settings saved.", and the next 20%-off draft priced
 * a $68.86 jacket at $36,160.01. Someone typing 150 into a margin box has made a typo,
 * not asked for the most extreme legal value. A word instead of a number took the same
 * path to `null` and switched the guardrail off without saying so.
 *
 * So a save is refused, naming each field and what it accepts, and nothing is written.
 */

import {
  DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT,
  DEFAULT_CONFIRM_ABOVE_VARIANTS,
} from "../campaigns/blast-radius";
import { formatCount } from "../format/display";
import { isKnownCurrency } from "../money/currency";
import { typedAmount } from "../money/typed-amount";

export interface GuardrailInputProblem {
  field: "minMarginPercent" | "minPrice" | "approvalThreshold" | "confirmAboveVariants" | "confirmAboveChangePercent";
  message: string;
}

/** The largest margin floor accepted: a price of at least cost ÷ 0.001. */
export const MAX_MARGIN_PERCENT = 99.9;

/**
 * The approval threshold's label, shared by the field and its refusal (#788), so the
 * message names the box the merchant is looking at rather than a key they have never seen.
 */
export const APPROVAL_THRESHOLD_LABEL = "Require a second person's approval above (variants)";

/**
 * A typed approval threshold: a whole number of variants, 1 or more, or null for off.
 * Undefined when it is neither.
 *
 * Digits only, rather than anything `Number` accepts. "1.5" variants is not a count, and
 * zero or a negative is not a threshold anybody meant: `approvalPolicyOf` reads either as
 * "off", so saving one would switch the rule off under "Settings saved."
 */
export function approvalThresholdFrom(value: FormDataEntryValue | null): number | null | undefined {
  const typed = text(value);
  if (typed === "") return null;
  if (!/^[0-9]+$/.test(typed)) return undefined;
  const count = Number(typed);
  return Number.isSafeInteger(count) && count >= 1 ? count : undefined;
}

/** The typed-confirmation thresholds' labels, shared by the fields and their refusals (#818). */
export const CONFIRM_VARIANTS_LABEL = "Ask for typed confirmation above (variants)";
export const CONFIRM_CHANGE_LABEL = "Or when a price moves more than (%)";

/**
 * A typed variant threshold for the typed confirmation: a whole number, 1 or more.
 * Undefined when it is anything else, blank included -- the confirmation has no "off".
 */
export function confirmVariantsFrom(value: FormDataEntryValue | null): number | undefined {
  const count = wholeNumber(value);
  return count !== undefined && count >= 1 ? count : undefined;
}

/**
 * A typed change threshold: a whole percentage from 1 to 100. Undefined otherwise.
 *
 * At most 100, because a reduction is already capped below it (#696): a threshold above it
 * could only ever be reached by an increase, and would quietly stop asking about the
 * reductions that are the reason this exists.
 */
export function confirmPercentFrom(value: FormDataEntryValue | null): number | undefined {
  const percent = wholeNumber(value);
  return percent !== undefined && percent >= 1 && percent <= 100 ? percent : undefined;
}

/** Digits only, as `approvalThresholdFrom`: `Number` would take `1e3`, `0x10` and `+5`. */
function wholeNumber(value: FormDataEntryValue | null): number | undefined {
  const typed = text(value);
  if (!/^[0-9]+$/.test(typed)) return undefined;
  const count = Number(typed);
  return Number.isSafeInteger(count) ? count : undefined;
}

type Read = (name: string) => FormDataEntryValue | null;

/**
 * Everything wrong with the typed guardrails, or an empty list. Blank means "none".
 *
 * A field missing from the form is blank here too. For the approval threshold that is not
 * the same as clearing it, and the action tells the two apart; this only says whether
 * what arrived can be saved.
 */
export function guardrailInputProblems(read: Read, currency: string): GuardrailInputProblem[] {
  const problems: GuardrailInputProblem[] = [];

  const margin = text(read("minMarginPercent"));
  if (margin !== "") {
    const value = Number(margin);
    if (!Number.isFinite(value) || value < 0 || value > MAX_MARGIN_PERCENT) {
      problems.push({
        field: "minMarginPercent",
        message: `Minimum margin (%) must be a number from 0 to ${MAX_MARGIN_PERCENT}, or blank for none. “${margin}” is not.`,
      });
    }
  }

  const floor = text(read("minPrice"));
  if (floor !== "") {
    const value = Number(floor);
    if (!Number.isFinite(value) || value < 0) {
      problems.push({
        field: "minPrice",
        message: `Minimum price (${currency}) must be zero or more, or blank for none. “${floor}” is not.`,
      });
    } else if (isKnownCurrency(currency)) {
      // Refused rather than rounded (#1068): `Math.round(9.995 * 100)` made a 9.995 floor
      // 9.99, below what was typed. A currency the table does not know cannot say how many
      // decimals it has, and is left to save as it always has.
      const typed = typedAmount(`Minimum price (${currency})`, floor, currency);
      if (!typed.ok) problems.push({ field: "minPrice", message: typed.message });
    }
  }

  const threshold = read("approvalThreshold");
  if (approvalThresholdFrom(threshold) === undefined) {
    problems.push({
      field: "approvalThreshold",
      message: `${APPROVAL_THRESHOLD_LABEL} must be a whole number of 1 or more, or blank for off. “${text(threshold)}” is not.`,
    });
  }

  // Checked only when the form carries them. Missing is not blank here either: a post
  // without the field keeps the stored value, and blank is refused, because neither
  // threshold can be switched off.
  const variants = read("confirmAboveVariants");
  if (variants !== null && confirmVariantsFrom(variants) === undefined) {
    problems.push({
      field: "confirmAboveVariants",
      message:
        `${CONFIRM_VARIANTS_LABEL} must be a whole number of 1 or more, such as the default ` +
        `${formatCount(DEFAULT_CONFIRM_ABOVE_VARIANTS)}. ${typedOrEmpty(variants)}`,
    });
  }

  const change = read("confirmAboveChangePercent");
  if (change !== null && confirmPercentFrom(change) === undefined) {
    problems.push({
      field: "confirmAboveChangePercent",
      message:
        `${CONFIRM_CHANGE_LABEL} must be a whole number from 1 to 100, such as the default ` +
        `${DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT}. ${typedOrEmpty(change)}`,
    });
  }

  return problems;
}

function typedOrEmpty(value: FormDataEntryValue): string {
  const typed = text(value);
  return typed === "" ? "It is empty." : `“${typed}” is not.`;
}

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
