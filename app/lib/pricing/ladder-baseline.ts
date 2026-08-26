/**
 * A wholesale ladder as it is stored on a baseline, and read back off one.
 *
 * The ladder lives in a JSON column, which means it is the one part of a price that the
 * database will not check for us. Everything here exists to make that safe:
 *
 * - **Integer minor units only.** A ladder that round-trips through JSON as `36.0` and
 *   comes back as a float is rule 7 broken in the least visible possible place. Anything
 *   that is not a whole number of minor units is refused on the way in and on the way out.
 * - **Refused, not repaired.** A stored ladder that cannot be parsed becomes `null` — no
 *   ladder — rather than a partial one. Half a ladder is a wholesale price list where the
 *   12+ tier exists and the 48+ tier silently does not, and a buyer pays the difference.
 */

import { money, type Money } from "../money/money";

export interface LadderRung {
  minimumQuantity: number;
  price: Money;
}

/** The stored shape. Amounts are integer minor units, never a formatted string. */
interface StoredRung {
  minimumQuantity: number;
  amount: number;
}

/**
 * A ladder ready to be written to the column, or null when there is nothing to store.
 *
 * An empty ladder stores as null rather than `[]`: "this variant has no quantity breaks"
 * is the state, and two encodings of one state is how a query ends up missing rows.
 */
export function serialiseLadder(rungs: readonly LadderRung[]): StoredRung[] | null {
  if (rungs.length === 0) return null;

  return [...rungs]
    .sort((a, b) => a.minimumQuantity - b.minimumQuantity)
    .map((rung) => {
      // `money()` refuses a fractional amount at construction, so this only fires for a
      // Money built as an object literal — which the type allows, and which is exactly how
      // a float reaches a price in practice.
      if (!Number.isInteger(rung.price.amount)) {
        throw new RangeError(
          `A quantity break at ${rung.minimumQuantity}+ has a price of ${rung.price.amount}, ` +
            `which is not a whole number of minor units.`,
        );
      }
      return { minimumQuantity: rung.minimumQuantity, amount: rung.price.amount };
    });
}

/**
 * The ladder stored on a baseline, or null if there isn't a usable one.
 *
 * `currency` comes from the baseline row rather than the JSON, because a ladder is
 * denominated in the same currency as the price it sits beside and storing it twice
 * invites the two to disagree.
 */
export function parseLadder(raw: unknown, currency: string): LadderRung[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const rungs: LadderRung[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const rung = entry as { minimumQuantity?: unknown; amount?: unknown };

    if (
      typeof rung.minimumQuantity !== "number" ||
      !Number.isInteger(rung.minimumQuantity) ||
      rung.minimumQuantity < 1 ||
      typeof rung.amount !== "number" ||
      !Number.isInteger(rung.amount)
    ) {
      // One bad rung discards the ladder. See the note above: half a ladder is worse
      // than none, because none is visible and half is not.
      return null;
    }

    rungs.push({
      minimumQuantity: rung.minimumQuantity,
      price: money(rung.amount, currency),
    });
  }

  rungs.sort((a, b) => a.minimumQuantity - b.minimumQuantity);

  // Two rungs at the same quantity is a ladder nobody can act on: Shopify keeps one and
  // there is no way to say which, so neither is the baseline.
  const duplicated = rungs.some(
    (rung, index) => index > 0 && rung.minimumQuantity === rungs[index - 1]!.minimumQuantity,
  );

  return duplicated ? null : rungs;
}
