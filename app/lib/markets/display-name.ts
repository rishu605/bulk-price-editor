/**
 * What to call a price list in front of a merchant.
 *
 * Shopify names a market's implicit price list itself, and the name it picks is not one:
 * on `dartmode-labs` the campaign editor listed
 *
 *     pricing_by_market.19853246698_1786915628 (USD)
 *
 * among the markets a campaign can price into — a checkbox deciding where a sale
 * reaches, labelled with an internal identifier. A second shape turns up beside it,
 * "Europe pricing - c41258df-9f1a-4666-8768-bb90e196d685", where a readable name has a
 * uuid welded to the end of it.
 *
 * The right name is already in the mirror. `markets-sync` stores `catalogTitle` — the
 * market catalog's own title, which is what the merchant named the market in Shopify —
 * and nothing had ever read it.
 *
 * ## Why the raw name is not simply replaced at sync time
 *
 * Because it is not a display string: `name` is what Shopify calls this list, it is what
 * a topology notice quotes when a market disappears, and it is what somebody comparing
 * the mirror against the Shopify admin would search for. Keeping it and choosing a label
 * at the point of display costs one function and loses nothing.
 */

/**
 * Names Shopify generated rather than a person.
 *
 * Deliberately narrow. A merchant is entitled to call a price list whatever they like,
 * including something that looks machine-made, and second-guessing a real name is worse
 * than showing one odd one.
 */
const GENERATED = [
  // Shopify's own name for the price list behind a market.
  /^pricing_by_market\./i,
  // A name with a uuid stuck on the end: "Europe pricing - c41258df-9f1a-4666-…".
  /\s-\s[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i,
];

export interface NameableList {
  /** What Shopify calls it. */
  name: string;
  /** The market catalog's title, where the list belongs to a market. */
  catalogTitle?: string | null;
  /** Markets and wholesale get different fallbacks, because they are different things. */
  surfaceKind?: string | null;
}

export function priceListLabel(list: NameableList): string {
  const name = list.name?.trim() ?? "";
  const generated = GENERATED.some((pattern) => pattern.test(name));

  if (!generated && name) return name;

  const title = list.catalogTitle?.trim();
  if (title) return title;

  // No catalog title either. Strip the machine half rather than print it: "Europe
  // pricing - c41258df-…" still has a usable name in front of the uuid.
  const stripped = name.replace(GENERATED[1], "").trim();
  if (stripped && !GENERATED[0].test(stripped)) return stripped;

  // Nothing readable anywhere. Say what it is rather than what it is called — an
  // identifier in a checkbox label tells a merchant nothing they can act on.
  return list.surfaceKind === "B2B" ? "A wholesale price list" : "A market price list";
}
