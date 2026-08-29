import type { ReactNode } from "react";

import { Blank } from "./Blank";
import { SPACE } from "../lib/ui/spacing";

/**
 * A price in a table cell: the number on its own line, and anything qualifying it below.
 *
 * ## The bug this exists to make unwriteable
 *
 * A money column is declared `format="currency"`, which right-aligns it, and the whole
 * reason to right-align a column of prices is that they line up on the decimal. Three
 * tables were then writing the qualifier into the same text run as the number:
 *
 * ```tsx
 * <s-table-cell>
 *   {row.after}
 *   {row.afterCompareAt ? ` (was ${row.afterCompareAt})` : ""}
 * </s-table-cell>
 * ```
 *
 * Which renders, in the editor's preview panel at its real width:
 *
 * ```
 *      Baseline        Would become
 *         10.02     8.02 (was 10.02)
 *         41.34        33.07 (was
 *                          41.34)
 *  1799.32 (was       1439.46 (was
 *     2598.79)           1799.32)
 * ```
 *
 * Two things are wrong there and only one of them is the wrapping. Because each suffix is
 * a different length, **no two prices in the column start at the same place** — the
 * alignment the `currency` format was asked for is destroyed on exactly the rows that
 * have something to say. And a price broken across a line at `(was` is not a price a
 * merchant can read at all.
 *
 * The rule that comes out of it: **a money cell's first line holds a number and nothing
 * else.** Everything else goes underneath.
 *
 * ## Why the compare-at is struck through rather than parenthesised
 *
 * `(was 10.02)` had a second problem the wrapping hid: in the preview table it appeared
 * in two adjacent columns meaning two different things — the baseline's compare-at in one
 * and the campaign's compare-at in the other — so row three read "1799.32 (was 2598.79)"
 * beside "1439.46 (was 1799.32)" and the same word pointed at two different facts.
 *
 * A struck-through number is not ambiguous, because it is what a storefront draws. It is
 * also already this app's vocabulary: `StorefrontExample` sits directly above this table
 * in the editor and renders the same pair that way, so the card and the table now say the
 * same thing in the same language rather than in two.
 *
 * `type="redundant"` and not a CSS line-through: Polaris documents that type for this
 * exact case and renders it as `<s>`, so a screen reader announces it. A line drawn in
 * CSS is a line only sighted merchants get.
 */
export function MoneyCell({
  amount,
  compareAt,
  note,
}: {
  /** The price. Null renders the app's em dash, like every other empty cell. */
  amount: string | null | undefined;
  /**
   * The price it is compared against, struck through beneath it.
   *
   * Ignored when it equals the amount, which is not a sale and must not be dressed as
   * one — the same rule `StorefrontExample` applies to the card above this table. Left as
   * string equality rather than a numeric comparison on purpose: a preview row carries no
   * currency, so there is no way to parse these into minor units here, and rule 7 rules
   * out comparing them as floats. The caller knows the semantics; this only knows how a
   * price looks.
   */
  compareAt?: string | null;
  /**
   * One short line under the price — "live 28.00", a reason a row will not be written.
   *
   * A slot rather than a string so the caller keeps its own tone. It sits below the
   * number for the reason the whole component exists: beside it, it moves the number.
   */
  note?: ReactNode;
}) {
  const struck = compareAt && compareAt !== amount ? compareAt : null;

  // No stack when there is only a number. A single `s-text` is what every other money
  // cell in the app renders, and wrapping the ordinary case in a layout element to serve
  // the exceptional one is how a table grows row height it did not need.
  if (!struck && !note) return amount ? <s-text>{amount}</s-text> : <Blank />;

  return (
    // `alignItems="end"` is load-bearing, and its absence is invisible in a diff.
    //
    // What `format="currency"` actually does, from `polaris.js` — the only account of it
    // that is true, since none of this is documented:
    //
    //     .table-cell { display: table-cell; padding: .5rem .75rem;
    //                   min-block-size: 2rem; vertical-align: middle }
    //     .format-currency, .format-numeric { font-feature-settings: "tnum";
    //                   font-variant-numeric: tabular-nums; text-align: end }
    //
    // So the alignment is `text-align` on the *cell*, and it reaches a text node by
    // inheritance. A stack is a flex container that fills the cell and positions its own
    // children, so the moment one is introduced the number stops taking the column's
    // alignment and starts taking the stack's — which defaults to the inline start.
    // Rendered, that put every row with a compare-at a few pixels left of every row
    // without one, so the column was ragged in a way that read as a rendering fault
    // rather than as anything anyone chose. Seen in the admin on this component's first
    // build, and it is why the ordinary case above returns a bare `s-text` rather than a
    // one-child stack.
    //
    // The same CSS is why nothing here sets `tabular-nums`: the format already does, and
    // a column of prices needs it more than anywhere else in the app.
    <s-stack gap={SPACE.tight} alignItems="end">
      {amount ? <s-text>{amount}</s-text> : <Blank />}
      {struck ? (
        <s-text color="subdued" type="redundant">
          {struck}
        </s-text>
      ) : null}
      {note}
    </s-stack>
  );
}
