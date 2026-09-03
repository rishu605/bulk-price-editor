/**
 * What each rounding option does, on a number.
 *
 * Sami: "Round to two decimal places. For example, a price of 10.458 would be rounded to
 * 10.46". RUBIX: "Before: 15.638 || After: 15.64". Ours said "Starts from your store
 * setting. Change it here to round this campaign differently" — which explains where the
 * value came from and not what it does, and "Nearest 10" is exactly the option where a
 * merchant's guess and the answer diverge. (Is that £10 or 10p? On a ¥ store, what is a
 * charm ending at all?)
 *
 * ## Computed, never written down
 *
 * The example runs the real profile through `applyRounding`. A hand-written string would
 * be a second implementation of rounding, free to disagree with the first — and it would
 * disagree silently, in the one place a merchant is being told they can trust it.
 *
 * ## The example price is not a constant
 *
 * It is derived from the currency's own precision. On a zero-decimal currency like JPY
 * there is nothing after the point to round, so a worked example showing decimals would
 * be teaching the merchant something false about their own store; "Prices ending .99" is
 * not merely unconventional in yen, it is unexpressible. Those options describe
 * themselves as unavailable rather than inventing a demonstration.
 */

import { isZeroDecimal } from "./currency";
import { formatMoneyForDisplay, money } from "./money";
import { applyRounding } from "./rounding";
import { ROUNDING_PROFILES, roundingLabel, type RoundingProfileName } from "./rounding-policy";

/**
 * A price awkward enough to show the difference.
 *
 * 234,762 minor units — $2,347.62, or ¥234,762. Not round in any of the senses on offer,
 * and awkward enough that five of the six options give five different answers. A tidier
 * number would make several look identical, which is the opposite of what an example is
 * for.
 *
 * The same integer in every currency, because the amount is in minor units and that is
 * what the profiles operate on. Scaling it per currency would make the JPY example a
 * different demonstration from the USD one.
 */
function samplePrice(): number {
  return 234_762;
}

export interface RoundingExample {
  /** The option, formatted before and after, or null where it cannot apply. */
  before: string;
  after: string | null;
  /** Why not, when there is no after. Shown in place of the example. */
  unavailable: string | null;
}

export function roundingExample(
  name: RoundingProfileName,
  currency: string,
): RoundingExample {
  const before = money(samplePrice(), currency);
  const zeroDecimal = isZeroDecimal(currency);

  // A charm ending is a fact about the sub-unit. In a currency that has none, the option
  // is not a bad choice — there is nothing it could mean.
  if (zeroDecimal && (name === "charm99" || name === "charm95")) {
    return {
      before: formatMoneyForDisplay(before),
      after: null,
      unavailable: `${currency} has no decimal places, so this has no effect here.`,
    };
  }

  // Same argument from the other side: "whole amounts, no cents" in a currency that is
  // already whole amounts is a no-op dressed up as a choice.
  if (zeroDecimal && name === "whole") {
    return {
      before: formatMoneyForDisplay(before),
      after: null,
      unavailable: `${currency} is already whole amounts.`,
    };
  }

  const after = applyRounding(before, ROUNDING_PROFILES[name]);

  return {
    before: formatMoneyForDisplay(before),
    after: formatMoneyForDisplay(after),
    unavailable: null,
  };
}

/** The one-line example a select's help text shows. */
/**
 * The result only, for a select option that has to fit inside a closed control.
 *
 * It used to be the whole sentence — "$2,347.62 becomes $2,347.99" — repeated in every
 * option, which made the longest of the six read `Leave prices exactly as calculated ·
 * $2,347.62 → $2,347.62`: fifty-eight characters in a control the campaign editor gives
 * about half a column. What a merchant saw was "Leave prices exactly as calc…".
 *
 * The starting price is identical in all six, so saying it once above the select and
 * showing only what each does to it loses nothing and halves the line. The comparison is
 * the point of putting examples in the options at all — all six explaining themselves
 * while the merchant chooses between them, rather than one line describing whichever is
 * already chosen — and that survives.
 *
 * `sampleLine` is the sentence that has to accompany this. An option reading "$2,347.99"
 * with nothing saying what it started from is a number with no question attached.
 */
export function roundingExampleLine(name: RoundingProfileName, currency: string): string {
  const example = roundingExample(name, currency);
  return example.unavailable ?? example.after ?? example.before;
}

/**
 * What the examples above start from, said once.
 *
 * Belongs in the `details` of any select whose options are built by `roundingChoices` —
 * see `rounding-choices.test.ts`, which refuses one that omits it.
 */
export function sampleLine(currency: string): string {
  return `Examples show what ${formatMoneyForDisplay(money(samplePrice(), currency))} becomes.`;
}

/**
 * A note on what "Nearest 10" turns out to mean, and what was done about it.
 *
 * Ten *minor units*, not ten pounds: `nearest10` is `{ step: 10 }` and a step is in minor
 * units by definition, so on a $2,347.62 price it produces $2,347.60 rather than the
 * $2,350 the old label implied. `nearest100` is a whole dollar, which is also why it
 * agreed with "Whole amounts" at every price.
 *
 * Fixed as a labelling change (#489), not an arithmetic one: `roundingLabel` says
 * "Nearest 0.10" in dollars and "Nearest 10" in yen, both of which are true, and
 * `roundingChoices` stops offering two names for one function. Changing the *steps* to
 * match the old words was the other option and it would re-price every campaign already
 * using them on its next run, which is not something a help-text ticket gets to do.
 */

/**
 * The options a picker should offer in this currency, and what each does to a price.
 *
 * Not every profile means something everywhere, and one of the acceptance criteria on
 * #489 was that no two options may be the same thing under different names. Both fall out
 * of the same question — does this profile do anything here that another does not:
 *
 *   - A charm ending is a fact about the sub-unit, so `.99` and `.95` are unexpressible in
 *     a currency that has none.
 *   - "Whole amounts, no cents" is a no-op where amounts are already whole.
 *   - And on a two-decimal currency, "whole" and the 100-minor-unit step land on exactly
 *     the same number for every input. They are one function reached by two names, and
 *     offering both is asking a merchant to choose between identical things. The charm
 *     profile keeps the slot: "Whole amounts, no cents" says what it does, where
 *     "Nearest 1.00" needs the merchant to work it out.
 *
 * A dropped option is dropped from the *picker*, not from the app. A campaign already
 * storing `nearest100` keeps it, keeps pricing exactly as it did, and reads back with a
 * true label — which is what makes this a labelling change rather than a pricing one.
 */
export function roundingChoices(
  currency: string,
): { value: RoundingProfileName; label: string; example: string }[] {
  const zeroDecimal = isZeroDecimal(currency);

  const offered = (Object.keys(ROUNDING_PROFILES) as RoundingProfileName[]).filter((name) => {
    if (zeroDecimal) return name !== "charm99" && name !== "charm95" && name !== "whole";
    return name !== "nearest100";
  });

  return offered.map((name) => ({
    value: name,
    label: roundingLabel(name, currency),
    example: roundingExampleLine(name, currency),
  }));
}
