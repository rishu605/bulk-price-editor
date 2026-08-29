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
import { ROUNDING_PROFILES, type RoundingProfileName } from "./rounding-policy";

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
export function roundingExampleLine(name: RoundingProfileName, currency: string): string {
  const example = roundingExample(name, currency);
  return example.unavailable ?? `${example.before} becomes ${example.after}`;
}

/**
 * A note on what "Nearest 10" turns out to mean.
 *
 * Ten *minor units*, not ten pounds: `nearest10` is `{ step: 10 }` and a step is in minor
 * units by definition, so on a $2,347.62 price it produces $2,347.60 rather than the
 * $2,350 the label implies. `nearest100` is a whole dollar, which is also why it agrees
 * with "Whole amounts" at every price — the two are the same function reached by two
 * names.
 *
 * That is a mislabelling with real consequences, and fixing it is a change to what a
 * merchant's prices become, so it is not being done quietly here as part of a help-text
 * ticket. What this example does is make the actual behaviour visible at the moment of
 * choosing, which is the narrower thing that was missing. See #489.
 */
