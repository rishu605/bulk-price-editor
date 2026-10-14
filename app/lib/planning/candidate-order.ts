/**
 * The one order a plan's variants come in: by title, then by variant id (#769).
 *
 * The full preview re-plans the whole scope for every page it shows and slices that
 * page out, so its pages only add up to the scope if every plan lists the variants in
 * the same order. They came in whatever order Postgres happened to return `variant_index`
 * rows -- which nothing fixed, and which a sync rewriting a row changed. On a live store
 * two variants jumped to the front of page 1 between two loads minutes apart, and a
 * merchant paging through would have seen some rows twice and others never.
 *
 * ## Title, because that is what the rows say
 *
 * A merchant reading a preview reads titles, and a list in title order keeps a product's
 * variants together. The title is the one the preview shows -- the variant id when there
 * is none -- so the list reads as sorted rather than as sorted by something hidden.
 * Compared the way a person would: "Boots 2" before "Boots 12", and "alpine" beside
 * "Alpine" rather than after "Zebra".
 *
 * ## Then the variant id, so the order is total
 *
 * Titles repeat -- two products can share a name, and so can their sizes -- and two rows
 * the comparison calls equal could come back either way round on the next load, which is
 * the bug again in a smaller place. The id is unique within a shop and compared byte by
 * byte, so no two rows ever tie.
 *
 * ## Sorted here rather than by Postgres
 *
 * `ORDER BY title, "variantGid"` sorts under the database's collation, and on a
 * 102,132-variant catalogue that cost about 600ms on every plan -- every keystroke's
 * preview included -- because no index serves it. Sorting the rows already loaded costs
 * about 190ms at that size, and gives the same order whatever collation the database
 * was created with.
 */

/** What ordering needs to know about a variant. */
export interface OrderedVariant {
  variantGid: string;
  title?: string | null;
}

/**
 * Pinned to one locale so the order cannot depend on the server's. `numeric` reads digit
 * runs as numbers, which is how sizes and model numbers are meant to be read.
 */
const TITLES = new Intl.Collator("en", { numeric: true });

/** By title as displayed, then by variant id. Never 0 for two different variants. */
export function compareVariants(a: OrderedVariant, b: OrderedVariant): number {
  return (
    TITLES.compare(a.title ?? a.variantGid, b.title ?? b.variantGid) ||
    (a.variantGid < b.variantGid ? -1 : a.variantGid > b.variantGid ? 1 : 0)
  );
}

/** A sorted copy. The input is left alone, since callers may still be reading it. */
export function inVariantOrder<T extends OrderedVariant>(rows: readonly T[]): T[] {
  return [...rows].sort(compareVariants);
}
