/**
 * When a campaign asks for "apply" to be typed before it runs (A-3.11, #818).
 *
 * The confirmation used to count rows and nothing else: over 1,000 written prices it asked,
 * under it it did not. So 95% off 999 variants -- a typo for 9.5%, or an exact price set
 * on the wrong collection -- applied from a one-click dialog, and that is the more
 * dangerous of the two mistakes the PRD guards against, because a row count cannot see it.
 *
 * Three things now ask, each said in its own sentence so the merchant knows which one:
 *
 * - **Size.** More written prices than the store's variant threshold (Settings, default
 *   1,000).
 * - **Depth.** Any written price moving more than the store's change threshold (Settings,
 *   default 50%) away from its baseline, or landing that far below its cost. A market's or
 *   wholesale catalogue's price as well as the base price (#1171), against its own baseline.
 * - **Prices taken to nothing.** More than a handful of prices the rule would take to zero
 *   or below, which are written at the smallest price instead. Not a setting: a merchant
 *   who raises the change threshold has not asked for a page of one-cent prices.
 * - **A discount compounded.** Any price this campaign already set whose baseline was since
 *   recaptured at that sale price (#781): applying again takes the discount off the discount,
 *   a 20% sale at 36% off. Not a setting either, and one is enough.
 *
 * Pure, and the one place these are decided, so the dialog that asks and the server that
 * refuses cannot disagree (rule 4). Integer minor units throughout: a percentage of a price
 * is compared by cross-multiplying, never by dividing one price by another (rule 7).
 */

import type { Money } from "../money/money";
import { formatCount } from "../format/display";

/** The variant threshold a store has until it changes it. PRD A-3.11. */
export const DEFAULT_CONFIRM_ABOVE_VARIANTS = 1_000;

/** The change threshold, in whole percent, a store has until it changes it. PRD A-3.11. */
export const DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT = 50;

/**
 * How many prices may be raised from zero to the smallest price before the word is asked.
 *
 * A handful, not none: a fixed-amount reduction across a catalogue that has a few cheap
 * accessories in it takes those few to the floor, and a confirmation for every such sale
 * is a confirmation nobody reads. More than this is a rule that is wrong for the scope.
 */
export const MINIMUM_PRICE_HANDFUL = 5;

export interface ConfirmThresholds {
  /** More written prices than this asks. */
  variants: number;
  /** A written price moving more than this whole percentage of its baseline asks. */
  changePercent: number;
}

/**
 * The thresholds a store's settings hold, as the preview reads them.
 *
 * `parseSettings` already fills both; the defaults here are for a caller holding settings
 * from before the keys existed, so that no path can read a missing threshold as "never".
 */
export function confirmThresholdsOf(settings: {
  confirmAboveVariants?: number;
  confirmAboveChangePercent?: number;
}): ConfirmThresholds {
  return {
    variants: settings.confirmAboveVariants ?? DEFAULT_CONFIRM_ABOVE_VARIANTS,
    changePercent: settings.confirmAboveChangePercent ?? DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT,
  };
}

/**
 * The scale `changePercent` is written in: whole percent. A percentage's hundred, not a
 * currency's minor units -- prices here are already minor units and are never converted.
 */
const WHOLE = 100;

/** One price a run would write, with what the depth test reads. */
export interface WrittenPrice {
  variantGid: string;
  baseline: Money;
  after: Money;
  /** The baseline's cost, when the variant has one. */
  cost?: Money;
  /** The market or wholesale catalogue the price is on, by name; absent for the base price (#1171). */
  market?: string;
}

/**
 * Whether this price moves further than `changePercent` allows.
 *
 * Away from the baseline in either direction: a 500% increase typed for 5% is the same
 * mistake as a 95% reduction typed for 9.5%. Or below cost by more than that share of the
 * cost -- with the default, under half of what the variant costs -- which a row starting
 * below cost can reach on a small move.
 *
 * A baseline of zero has no percentage to move by, so only the cost test applies to it. A
 * price in another currency than its baseline is never compared: the planner leaves those
 * rows unwritten anyway.
 */
export function exceedsChange(row: WrittenPrice, changePercent: number): boolean {
  const { baseline, after, cost } = row;
  if (after.currency !== baseline.currency) return false;

  const base = baseline.amount;
  if (base > 0 && WHOLE * Math.abs(after.amount - base) > changePercent * base) return true;

  return (
    !!cost &&
    cost.currency === after.currency &&
    cost.amount > 0 &&
    WHOLE * after.amount < (WHOLE - changePercent) * cost.amount
  );
}

/**
 * How far a price moves from its baseline, in hundredths of a percent, for saying so.
 * Zero for a baseline of zero, which has no percentage.
 */
export function movedBasisPoints(row: Pick<WrittenPrice, "baseline" | "after">): number {
  const base = row.baseline.amount;
  if (base <= 0) return 0;
  return Math.floor((Math.abs(row.after.amount - base) * 10_000) / base);
}

export interface LargeChanges {
  count: number;
  /** The one moving furthest from its baseline; the first of equals. */
  largest: (WrittenPrice & { basisPoints: number }) | null;
}

/** The written prices that exceed the change threshold, and the largest of them. */
export function largeChanges(rows: Iterable<WrittenPrice>, changePercent: number): LargeChanges {
  let count = 0;
  let largest: LargeChanges["largest"] = null;

  for (const row of rows) {
    if (!exceedsChange(row, changePercent)) continue;
    count++;
    const basisPoints = movedBasisPoints(row);
    if (!largest || basisPoints > largest.basisPoints) largest = { ...row, basisPoints };
  }

  return { count, largest };
}

/**
 * What the preview found, in the shape the dialog renders and the server re-checks.
 *
 * Prices in `largest` are already formatted, because this crosses to the browser and the
 * dialog only says them.
 */
export interface BlastRadius {
  thresholds: ConfirmThresholds;
  /** Prices this campaign writes. */
  planned: number;
  /** Written prices exceeding the change threshold. */
  largeChanges: number;
  largest: {
    title: string;
    /** Its market or wholesale catalogue, when it is a price there (#1171). */
    market?: string;
    before: string;
    after: string;
    basisPoints: number;
    direction: "down" | "up";
  } | null;
  /**
   * Of `largeChanges`, how many are a market's or wholesale catalogue's prices (#1171), which
   * the depth now counts as it counts the base price's. Absent on a preview stored before it did.
   */
  marketLargeChanges?: number;
  /** Prices the rule takes to zero or below, written at the smallest price instead. */
  atMinimum: number;
  /**
   * Written prices this campaign already set, whose baseline was recaptured at that sale price
   * since, so the write discounts its own discount (#781), with the first one's title. Absent
   * when there are none, and on a preview stored before it was counted.
   */
  compounding?: { count: number; title: string };
}

/** Whether what was typed into a confirmation box is the word: "apply", in any case, spaces aside. */
export function typedTheWord(typed: string): boolean {
  return typed.trim().toLowerCase() === "apply";
}

/** Whether a campaign with this preview has to be confirmed by typing the word. */
export function asksForConfirmation(radius: BlastRadius): boolean {
  return (
    radius.planned > radius.thresholds.variants ||
    radius.largeChanges > 0 ||
    radius.atMinimum > MINIMUM_PRICE_HANDFUL ||
    (radius.compounding?.count ?? 0) > 0
  );
}

/** "95%", or "94.5%" where a tenth matters. */
export function percentText(basisPoints: number): string {
  const tenths = Math.round(basisPoints / 10);
  return tenths % 10 === 0 ? `${tenths / 10}%` : `${(tenths / 10).toFixed(1)}%`;
}

/**
 * Why the word is asked, one sentence per reason, for the dialog and the refusal alike.
 *
 * No prices in them, only counts, percentages and a product's title: the server's refusal
 * is these sentences too, and a sentence that never carries a price cannot leak one into
 * whatever logs it. The dialog shows the largest change's prices beside them.
 */
export function confirmationReasons(radius: BlastRadius): string[] {
  const { thresholds, planned, largeChanges: large, largest, atMinimum } = radius;
  const reasons: string[] = [];

  if (planned > thresholds.variants) {
    reasons.push(
      `This campaign writes ${formatCount(planned)} prices, more than the ${formatCount(thresholds.variants)} ` +
        "your settings allow without a typed confirmation.",
    );
  }

  if (large > 0) {
    const one = large === 1;
    reasons.push(
      `${formatCount(large)} ${one ? "price moves" : "prices move"} more than ${thresholds.changePercent}% from ` +
        `${one ? "its" : "their"} baseline, or ${one ? "lands" : "land"} that far below cost` +
        (largest
          ? `; the largest is ${largestName(largest)}, ${largest.direction} ${percentText(largest.basisPoints)}.`
          : "."),
    );
  }

  if (atMinimum > MINIMUM_PRICE_HANDFUL) {
    reasons.push(
      `${formatCount(atMinimum)} prices would reach zero or below, and would be written at the smallest price instead.`,
    );
  }

  // First when it is there: it is the one reason that is a wrong price rather than a big one.
  if (radius.compounding && radius.compounding.count > 0) reasons.unshift(compoundingReason(radius.compounding));

  return reasons;
}

/** The largest change's product, in quotes, and the market it is in when it is a market's price (#1171). */
export function largestName(largest: { title: string; market?: string }): string {
  return `“${largest.title}”${largest.market ? ` in ${largest.market}` : ""}`;
}

/**
 * The compounding, named (#781): "applying twice gives the same result" is the promise the
 * dialog makes, and it is not true of these.
 */
export function compoundingReason({ count, title }: { count: number; title: string }): string {
  const one = count === 1;
  return (
    (one
      ? `“${title}” already shows this campaign's price, and would be discounted again: its baseline was`
      : `${formatCount(count)} prices this campaign already set would be discounted again, the first “${title}”: their baselines were`) +
    " recaptured at the sale price while the campaign was live, so applying it now compounds the discount, taking it " +
    "off the sale price rather than the price before the sale."
  );
}
