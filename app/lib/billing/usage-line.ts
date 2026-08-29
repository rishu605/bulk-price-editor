/**
 * The plan meter, as a sentence.
 *
 * Reassuring rather than threatening, deliberately. D3 says safety features are never
 * paywalled: preview, revert, the ledger and the drift hold are on every tier including
 * free, and the cap is on how much one campaign may cover. A meter that reads like a
 * countdown to being cut off would be describing a product we did not build — and it
 * would do it on the dashboard, which is the page a merchant sees most.
 *
 * So the sentence leads with what is covered. It only mentions the cap being reachable
 * when the catalogue is actually bigger than it, and even then it says what happens
 * (the campaign is refused before it writes anything) rather than implying something has
 * already gone wrong.
 */

import { formatCount } from "../format/display";

export interface UsageLine {
  headline: string;
  detail: string;
  /** Whether to draw attention. False unless the cap can actually be reached. */
  attention: boolean;
}

export function usageLine(usage: {
  planName: string;
  variantLimit: number | null;
  catalogueVariants: number;
  couldExceed: boolean;
}): UsageLine {
  const catalogue = `${formatCount(usage.catalogueVariants)} variants`;

  if (usage.variantLimit === null) {
    return {
      headline: `${usage.planName} · no variant limit`,
      detail: `Your catalogue is ${catalogue}. A campaign can cover all of it.`,
      attention: false,
    };
  }

  const cap = formatCount(usage.variantLimit);

  if (!usage.couldExceed) {
    return {
      headline: `${usage.planName} · campaigns up to ${cap} variants`,
      detail: `Your whole catalogue is ${catalogue}, so no campaign can reach the limit.`,
      attention: false,
    };
  }

  return {
    headline: `${usage.planName} · campaigns up to ${cap} variants`,
    // Says what happens, not that something is wrong. A campaign over the cap is refused
    // before it writes anything, which is the same promise the rest of the app makes.
    detail: `Your catalogue is ${catalogue}, so a campaign covering all of it would need a larger plan. Anything over the limit is refused before it writes a price.`,
    attention: true,
  };
}
