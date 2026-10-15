/**
 * Why a campaign has no price to put back for a drifted variant (#1042).
 *
 * "Put it back" plans the campaign for the one variant. A variant that has left the
 * campaign's scope since -- archived, re-tagged, out of its segment -- plans nothing, and
 * nothing planned read as "the storefront already shows the campaign's price": the event
 * closed as put back while the merchant's edit stayed live. The campaign has no price for
 * such a variant any more -- its revert recomputes without it (rule 6) -- so the put-back
 * is refused, naming why, and the question stays open.
 */

export type NotPriced =
  | { reason: "excluded" }
  | { reason: "deleted" }
  | { reason: "gift-card" }
  | { reason: "status"; status: string; statuses: readonly string[] }
  | { reason: "scope" }
  | { reason: "baseline" };

/** What the mirror says about one variant, against one campaign. */
export interface VariantFacts {
  /** The mirror's row, or null when the variant is not in it. */
  row: { deletedAt: Date | null; status: string; isGiftCard: boolean } | null;
  /** Taken out of the campaign on its own. */
  excluded: boolean;
  /** Matched by the campaign's current segment or filter, product statuses included. */
  inScope: boolean;
  /** Has a current base-price baseline to compute from. */
  hasBaseline: boolean;
}

/**
 * Why the campaign does not price this variant, or null when it does.
 *
 * `statuses` are the product statuses the campaign covers; undefined covers every one.
 */
export function whyNotPriced(facts: VariantFacts, statuses: readonly string[] | undefined): NotPriced | null {
  if (facts.excluded) return { reason: "excluded" };
  if (!facts.row || facts.row.deletedAt) return { reason: "deleted" };
  if (facts.row.isGiftCard) return { reason: "gift-card" };
  if (!facts.inScope) {
    return statuses && !statuses.includes(facts.row.status)
      ? { reason: "status", status: facts.row.status, statuses }
      : { reason: "scope" };
  }
  if (!facts.hasBaseline) return { reason: "baseline" };
  return null;
}

/** "active", "active or draft". */
function statusList(statuses: readonly string[]): string {
  const words = statuses.map((status) => status.toLowerCase());
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : (words[0] ?? "");
}

/**
 * The refusal of one put-back: the variant, why the campaign has no price for it, and what
 * the merchant can do instead. `which` is the variant as the page names it.
 */
export function notPricedMessage(why: NotPriced, campaign: string, variant: string): string {
  const name = `"${campaign}"`;
  // At the start of a sentence: "this variant" is the fallback for one with no title.
  const which = variant.charAt(0).toUpperCase() + variant.slice(1);
  const choose = "choose Keep the change or Leave it for now.";
  switch (why.reason) {
    case "excluded":
      return `${which} was taken out of ${name} on its own, so the campaign has no price to put back for it. Nothing was written and the drift stays open: ${choose}`;
    case "deleted":
      return `${which} is no longer in your Shopify catalogue, so ${name} has no price to put back for it. Nothing was written and the drift stays open: ${choose}`;
    case "gift-card":
      return `${which} is a gift card, which ${name} never prices, so it has no price to put back for it. Nothing was written and the drift stays open: ${choose}`;
    case "status":
      return (
        `${which}'s product is ${why.status.toLowerCase()} now, and ${name} prices only ${statusList(why.statuses)} products, ` +
        `so it has no price to put back for it. Nothing was written and the drift stays open. Set the product back to ` +
        `${statusList(why.statuses)} and put it back again, or ${choose}`
      );
    case "scope":
      return (
        `${which} no longer matches ${name}'s segment or filter, so the campaign has no price to put back for it. ` +
        `Nothing was written and the drift stays open. Bring it back into the campaign's products and put it back again, or ${choose}`
      );
    case "baseline":
      return (
        `${which} has no baseline, so ${name} has nothing to compute its price from. Nothing was written and the drift ` +
        `stays open. Capture its baseline on the Baselines page and put it back again, or ${choose}`
      );
  }
}
