/**
 * What a catalogue sync tells the merchant it did.
 *
 * ## Why it is a function and not a template in the action
 *
 * Two reasons, and the second is the one that made it worth moving.
 *
 * **Grouping.** It was built with raw interpolation — `Synced ${sync.variants} variants` —
 * so the banner read "Synced 3669 variants across 1037 products" two inches above a tile
 * reading "3,669". `format/display.ts` opens with a paragraph about why every number in
 * this app goes through `formatCount`, and this was the one place on Home that did not.
 *
 * **Units.** "Captured 0 baselines, 3672 already current" sat beside "Variants 3,669",
 * and 3,672 is not a count of variants at all — it is price *surfaces*, which is one per
 * variant per market a variant is priced in. Two numbers three apart, on one screen,
 * counting different things and both unlabelled, invite an arithmetic that cannot work.
 * The unit is named here instead.
 *
 * Pluralisation comes with it: "1 variants" and "1 products" were both reachable.
 */

import { formatCount } from "../format/display";

export interface SyncOutcome {
  /** Variants written to the mirror. */
  variants: number;
  /** Products they belong to. */
  products: number;
  /** Baselines recorded for surfaces that had none. */
  captured: number;
  /** Surfaces that already had a current baseline, so nothing was written for them. */
  alreadyCurrent: number;
  /** Market price lists mirrored. */
  priceLists: number;
  /** Of those, the ones derived from a percentage rather than fixed prices. */
  relative: number;
  /** Individual fixed prices read from those lists. */
  entries: number;
}

const plural = (count: number, one: string, many = `${one}s`) => (count === 1 ? one : many);

/** A count and its unit, grouped: "3,669 variants", "1 product". */
const count = (value: number, one: string, many?: string) =>
  `${formatCount(value)} ${plural(value, one, many)}`;

export function syncMessage(outcome: SyncOutcome): string {
  const parts = [
    `Synced ${count(outcome.variants, "variant")} across ${count(outcome.products, "product")}.`,
    `Captured ${count(outcome.captured, "baseline")}`,
  ];

  // Named as surfaces rather than left to read as variants. See the note above.
  if (outcome.alreadyCurrent > 0) {
    parts[1] += `, ${count(outcome.alreadyCurrent, "price surface")} already had one`;
  }
  parts[1] += ".";

  if (outcome.priceLists > 0) {
    let markets = `Mirrored ${count(outcome.priceLists, "price list")}`;
    if (outcome.relative > 0) {
      markets += ` (${formatCount(outcome.relative)} derived from a percentage)`;
    }
    if (outcome.entries > 0) {
      markets += `, ${count(outcome.entries, "fixed price")}`;
    }
    parts.push(`${markets}.`);
  }

  return parts.join(" ");
}
