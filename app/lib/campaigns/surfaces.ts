/**
 * Which prices a campaign writes: the base price, the price lists it names, or both.
 *
 * Pure, so the resolver's input can be built from it as well as the market writer: whether
 * a campaign prices the base price is decided here, once, and read by the planner (#1094).
 * Kept out of `market-surfaces.server.ts`, which the campaign model cannot import without
 * importing itself.
 */

import type { QuantityTier } from "../pricing/quantity-breaks";

/** Which surfaces a campaign writes to. Stored on the campaign as JSON. */
export interface CampaignSurfaces {
  base: boolean;
  /** Price list gids this campaign also prices. Empty means base only. */
  priceLists: string[];
  /**
   * Wholesale quantity tiers, for the B2B price lists among `priceLists`.
   *
   * Absent means a single price per variant, which is what every campaign written before
   * this existed meant and must keep meaning. Only B2B catalogues have ladders — a market
   * price list has no concept of ordering twelve — so this is ignored for market lists
   * rather than refused, and the planner is where that distinction is made.
   */
  quantityTiers?: QuantityTier[];
}

/**
 * Reads the surfaces blob defensively.
 *
 * It is JSON on a row, so it can be anything: written by an older version, hand-edited,
 * or half-migrated. A tier list that cannot be understood becomes no tiers rather than a
 * crash — but never a *different* ladder, because silently pricing wholesale differently
 * from what the merchant configured is the failure this whole surface has to avoid.
 */
export function parseSurfaces(raw: unknown): CampaignSurfaces {
  const value = (raw ?? {}) as {
    base?: unknown;
    priceLists?: unknown;
    quantityTiers?: unknown;
  };

  const tiers = Array.isArray(value.quantityTiers)
    ? value.quantityTiers.filter(isQuantityTier)
    : undefined;

  return {
    // Base is on unless explicitly turned off. A campaign targeting only a market is
    // legitimate but unusual, and defaulting it off would silently narrow every
    // campaign created before markets existed.
    base: value.base !== false,
    priceLists: Array.isArray(value.priceLists)
      ? value.priceLists.filter((entry): entry is string => typeof entry === "string")
      : [],
    // A list that had entries and lost them all to validation is not the same as no list.
    // Reporting it as `[]` lets the planner refuse loudly instead of pricing at one tier.
    ...(tiers === undefined ? {} : { quantityTiers: tiers }),
  };
}

function isQuantityTier(entry: unknown): entry is QuantityTier {
  if (typeof entry !== "object" || entry === null) return false;
  const tier = entry as { minimumQuantity?: unknown; discountBps?: unknown };

  return (
    typeof tier.minimumQuantity === "number" &&
    Number.isFinite(tier.minimumQuantity) &&
    typeof tier.discountBps === "number" &&
    Number.isFinite(tier.discountBps)
  );
}
