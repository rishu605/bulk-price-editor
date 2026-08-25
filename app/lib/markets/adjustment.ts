/**
 * Price list parent adjustments, in integer arithmetic.
 *
 * A market price list usually does not store prices. It stores a percentage against
 * another list, and Shopify derives every price from it. That single fact decides how
 * a campaign can write to the surface at all: a relative list can be repriced with one
 * mutation against the adjustment (P5.2), where a fixed list needs a row per variant.
 *
 * The adjustment is kept in **basis points**, and never as a float. Shopify reports it
 * as a JSON number, and 5% arriving as 5.000000000000001 would be harmless right up
 * until it multiplied a six-figure catalogue and left a trail of prices a penny off
 * that nobody could account for. Integers in, integers out, one rounding step that is
 * written down.
 */

import { money, type Money } from "../money/money";

/** Shopify's adjustment types on `PriceListParent`. */
export type AdjustmentType = "PERCENTAGE_DECREASE" | "PERCENTAGE_INCREASE";

export interface ParentAdjustment {
  /**
   * A plain string, not the union.
   *
   * It arrives from the API, which is free to grow a new adjustment kind without
   * asking. Narrowing at the boundary would turn that into a runtime cast we would
   * forget; accepting the string and rejecting what we do not recognise keeps the
   * unknown case explicit — and `toBasisPoints` returning null is what makes an
   * unrecognised kind visible rather than silently zero.
   */
  type: string;
  /** Percent, as Shopify reports it. 5 means five percent. */
  value: number;
}

/**
 * Converts an adjustment to signed basis points.
 *
 * A decrease is negative, so a single number carries direction and there is no second
 * field to forget to check. Returns null for anything unrecognised rather than
 * defaulting to zero: zero is a real adjustment meaning "same as base", and silently
 * conflating "no adjustment" with "unparseable" would mirror a market at the wrong
 * price with nothing to indicate it.
 */
export function toBasisPoints(adjustment: ParentAdjustment | null | undefined): number | null {
  if (!adjustment || !Number.isFinite(adjustment.value)) return null;
  if (adjustment.type !== "PERCENTAGE_DECREASE" && adjustment.type !== "PERCENTAGE_INCREASE") {
    return null;
  }

  const magnitude = Math.round(Math.abs(adjustment.value) * 100);
  return adjustment.type === "PERCENTAGE_DECREASE" ? -magnitude : magnitude;
}

/** Renders basis points back as a percentage, for display and for writing back. */
export function toPercent(bps: number): number {
  return bps / 100;
}

/**
 * Applies an adjustment to a base price.
 *
 * Rounds half away from zero, which is what Shopify does and — more to the point — is
 * symmetric: a 10% decrease and the matching increase land on the same place from
 * either direction, so a market price does not drift by a penny each time a campaign
 * recomputes it.
 */
export function applyAdjustment(base: Money, bps: number): Money {
  const scaled = (base.amount * (10_000 + bps)) / 10_000;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return money(rounded, base.currency);
}

/** True when a list derives its prices rather than storing them. */
export function isRelative(adjustmentBps: number | null | undefined): boolean {
  return adjustmentBps !== null && adjustmentBps !== undefined;
}

/**
 * Whether a mirrored price entry is one Shopify derived or one somebody set.
 *
 * `RELATIVE` entries are the parent adjustment applied, and mirroring them per variant
 * would restate a single percentage a few million times. Only `FIXED` entries carry
 * information the rule does not already hold.
 */
export function isFixedOrigin(originType: string | null | undefined): boolean {
  return originType === "FIXED";
}
