import type { ReactNode } from "react";

import { SPACE } from "../lib/ui/spacing";

/**
 * A table, the sentence that qualifies it and its pagination, as one object.
 *
 * They were three separate children of the card, spaced by the card's own rhythm — the
 * gap meant for the distance between a paragraph and the fields under it. So on Variants
 * the rows, "Amounts are your store's base price, in USD." and "51–100 of 3,412" sat as
 * far apart as two unrelated blocks, and none of them read as belonging to the rows above.
 *
 * The parts already existed and were shared: `Pagination`, `ShowingSome`, and a caption
 * written out per route as a loose paragraph. What did not exist was anything binding them
 * to the table they describe.
 *
 * ## Why the caption is above the pagination and below the table
 *
 * A caption qualifies the rows — what currency, what surface, what is excluded — so it is
 * read with them. Pagination is a control, and a control that moves you off the rows
 * belongs after everything that describes them. Routes had it both ways round; this settles
 * it.
 *
 * ## The gap
 *
 * `SPACE.item`, deliberately smaller than the card's own rhythm. Three things at the card's
 * rhythm are three things; at item rhythm they are one thing with two footnotes, which is
 * what they are.
 */
export function TableBlock({
  children,
  caption,
  pagination,
}: {
  /** The table itself. */
  children: ReactNode;
  /** What qualifies the rows: a currency, a surface, what is not shown. */
  caption?: ReactNode;
  /** `Pagination` or `ShowingSome` — whichever this table has. */
  pagination?: ReactNode;
}) {
  return (
    <s-stack gap={SPACE.item}>
      {children}
      {caption}
      {pagination}
    </s-stack>
  );
}
