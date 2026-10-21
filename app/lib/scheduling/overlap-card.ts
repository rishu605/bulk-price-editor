/**
 * The calendar's card of campaigns on at the same time: what it says, and where its one
 * link goes (#979, #1016).
 */

import { countOf } from "../format/display";

/**
 * A campaign in an overlap: whether its price is the one other campaigns plan against,
 * and whether it is still to come.
 *
 * Both are said so the card's link can open a page that answers its question. A
 * campaign's preview plans it against the campaigns pricing now (`competingCampaigns`),
 * so the page showing which price each shared product gets is one whose *other* campaign
 * is pricing -- and a finished campaign's page has nothing to compare at all.
 */
export interface OverlapSide {
  id: string;
  name: string;
  /** In a pricing state and not being ended: what `competingCampaigns` would return. */
  pricing: boolean;
  /** Scheduled: still to come, and planned against what is pricing when it is previewed. */
  scheduled: boolean;
}

export interface Overlap {
  a: OverlapSide;
  b: OverlapSide;
  /** Variants in both campaigns' scopes. Zero means they share a week, not a product. */
  sharedVariants: number;
  /** The first of the two windows has closed, so they are no longer on together. */
  ended: boolean;
}

/**
 * Whether two campaigns' time together is over: the earlier of their windows has closed.
 *
 * A fact about the pair, not about each campaign (#1016). #979 kept the present while
 * either was still on, so a sale still up beside a weekend sale reverted on Sunday read
 * "run together", as if both were live now. They stopped overlapping when the weekend sale
 * ended. The windows are the ones the calendar draws, so a completed campaign's ends where
 * its revert did.
 */
export function overlapEnded(
  a: { endAt?: string | null },
  b: { endAt?: string | null },
  now: string,
): boolean {
  const ends = [a.endAt, b.endAt].filter((end): end is string => Boolean(end)).map((end) => Date.parse(end));
  return ends.length > 0 && Math.min(...ends) <= Date.parse(now);
}

/**
 * What two campaigns on the calendar at once did together, after their names.
 *
 * In the past tense once their overlap has ended (#979, #1016). "Run together and share"
 * over two campaigns completed months ago read as a collision on the storefront now.
 *
 * But not a past count (#1058). The shared number is what both campaigns' scopes match
 * today, and nothing records what they matched while they ran: a segment edited, products
 * added or deleted since, all change it. So an ended overlap says the count is as the two
 * are set up now, rather than presenting it as history. Recording a scope at apply time
 * would let it say more; until there is a reason to, it says only what it knows.
 */
export function overlapSentence(overlap: Pick<Overlap, "ended" | "sharedVariants">): string {
  const shared = overlap.sharedVariants;
  if (overlap.ended) {
    return shared > 0
      ? `ran together. As they are set up now, ${countOf(shared, "product")} ${shared === 1 ? "is" : "are"} in both.`
      : "ran together. As they are set up now, they have no products in common.";
  }
  return shared > 0
    ? `run together and share ${countOf(shared, "product")}.`
    : "run together, but have no products in common.";
}

/**
 * The card around the overlaps: its heading, its introduction, and the one link.
 *
 * In the past when every overlap on it has ended. One still going keeps the present,
 * because then the card is about the storefront now, and each pair's own sentence says
 * which of them are history.
 *
 * The link opens the preview of the first pair that still shares products and whose
 * preview would show them resolved: one campaign pricing, and the page of a campaign that
 * plans against it -- the other one if it is still to come, or either if both are up.
 * A pair that has ended, or two campaigns both still to come, gets no link: no page
 * compares them.
 */
export function overlapCard(overlaps: readonly Overlap[]): {
  heading: string;
  intro: string;
  priceLink: string | null;
} {
  const past = overlaps.length > 0 && overlaps.every((overlap) => overlap.ended);

  return past
    ? {
        heading: "Campaigns that ran at the same time",
        intro:
          "Overlapping campaigns never stack. While these ran together, the higher priority one won every product they shared.",
        priceLink: null,
      }
    : {
        heading: "Campaigns running at the same time",
        intro:
          "Overlapping campaigns never stack. The higher priority one wins every product they share, and the preview shows exactly which price each gets.",
        priceLink: priceLinkOf(overlaps),
      };
}

/** A campaign whose preview plans it against `other`: `other` is pricing, and it can be previewed against it. */
function plansAgainst(campaign: OverlapSide, other: OverlapSide): boolean {
  return other.pricing && (campaign.pricing || campaign.scheduled);
}

function priceLinkOf(overlaps: readonly Overlap[]): string | null {
  for (const overlap of overlaps) {
    if (overlap.ended || overlap.sharedVariants === 0) continue;
    const target = plansAgainst(overlap.a, overlap.b)
      ? overlap.a
      : plansAgainst(overlap.b, overlap.a)
        ? overlap.b
        : null;
    if (target) return `/app/campaigns/${target.id}?tab=preview`;
  }
  return null;
}
