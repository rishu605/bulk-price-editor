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

/**
 * Where the gift cards went, when there are any (#1075).
 *
 * The count is what a campaign can cover, and no campaign prices a gift card -- its price
 * is its face value. Left unsaid, a merchant who knows their catalogue is 3,669 variants
 * reads 3,665 as the app having lost four.
 */
export function giftCardNote(giftCards: number): string {
  if (giftCards <= 0) return "";
  return giftCards === 1
    ? "1 gift card is not counted: no campaign prices a gift card."
    : `${formatCount(giftCards)} gift cards are not counted: no campaign prices a gift card.`;
}

export function usageLine(usage: {
  planName: string;
  variantLimit: number | null;
  /**
   * Variants a campaign could cover: live, and not gift cards (#1075). Deleted variants
   * and gift cards are in no campaign's scope, so counting them told a shop near its limit
   * that it could exceed it by variants no campaign would ever count.
   */
  catalogueVariants: number;
  /** Live gift cards, left out of `catalogueVariants` and said so. */
  giftCards?: number;
  couldExceed: boolean;
  /**
   * Whether the catalogue has been read at all.
   *
   * Before the first sync `catalogueVariants` is 0 — not because the shop is empty but
   * because nobody has looked. See the branch below.
   */
  synced: boolean;
  /** A development store, which has every feature whatever plan it is on. */
  exempt?: boolean;
}): UsageLine {
  // Said as what it is. Home used to name the tier a development store is *treated* as --
  // "Wholesale" -- while the plan page said "You are on Free", and billing is the first
  // thing App Review checks on exactly this kind of store (#860).
  if (usage.exempt) {
    return {
      headline: "Development store · every feature included",
      detail: "Nothing is charged here. Changing plan creates a test charge, so you can try it from See plans.",
      attention: false,
    };
  }

  const catalogue = `${formatCount(usage.catalogueVariants)} variants`;
  const cap = usage.variantLimit === null ? null : formatCount(usage.variantLimit);

  // Before the first sync there is no catalogue to reason about, and reasoning about it
  // anyway is how the first screen after installing came to tell a 102,132-variant shop
  // "Your whole catalogue is 0 variants, so no campaign can reach the limit." Zero is
  // what "we have not looked" looks like in this number, and the sentence read it as a
  // fact about the store. See #615.
  if (!usage.synced) {
    return {
      headline:
        cap === null
          ? `${usage.planName} · no variant limit`
          : `${usage.planName} · campaigns up to ${cap} variants`,
      detail:
        cap === null
          ? "A campaign can cover your whole catalogue, whatever size it turns out to be."
          : "Sync your catalogue and this will say how much of it one campaign can cover.",
      attention: false,
    };
  }

  const giftCards = giftCardNote(usage.giftCards ?? 0);
  const withGiftCards = (detail: string) => (giftCards ? `${detail} ${giftCards}` : detail);

  if (usage.variantLimit === null) {
    return {
      headline: `${usage.planName} · no variant limit`,
      detail: withGiftCards(`Your catalogue is ${catalogue}. A campaign can cover all of it.`),
      attention: false,
    };
  }

  if (!usage.couldExceed) {
    return {
      headline: `${usage.planName} · campaigns up to ${cap} variants`,
      detail: withGiftCards(`Your whole catalogue is ${catalogue}, so no campaign can reach the limit.`),
      attention: false,
    };
  }

  return {
    headline: `${usage.planName} · campaigns up to ${cap} variants`,
    // Says what happens, not that something is wrong. A campaign over the cap is refused
    // before it writes anything, which is the same promise the rest of the app makes.
    detail: withGiftCards(
      `Your catalogue is ${catalogue}, so a campaign covering all of it would need a larger plan. Anything over the limit is refused before it writes a price.`,
    ),
    attention: true,
  };
}
