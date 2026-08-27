import type { ReactNode } from "react";

import { FilterForm } from "../FilterForm";
import { SPACE } from "../../lib/ui/spacing";

/**
 * The search every prices tab shares, plus whatever else that tab filters on.
 *
 * `FilterForm`, never a native form element: a plain GET submit replaces the whole query
 * string including the `host` and `id_token` App Bridge put there, and the merchant gets
 * a blank page with nothing in the console to explain it.
 *
 * It merges rather than replaces, which is what lets a search survive a tab switch —
 * the tab links carry the query string, and this puts `q` back into it rather than
 * rebuilding it from scratch.
 *
 * The two directions take different rhythms, and that is the rule rather than an
 * exception to it. Inline, the field and the button share one baseline and read as a
 * single control, so they sit at item rhythm and align on their bottom edge — the label
 * is hidden in that mode, so the two are the same height and `end` is what puts the
 * button on the field's line rather than floating above it. Stacked, every field carries
 * its own visible label, and item rhythm leaves that label crowding the field above it;
 * stacked fields get section rhythm so each one owns its label.
 */
export function VariantSearch({
  fields,
  query,
  label = "Search",
  placeholder = "Search by title or SKU",
  /**
   * Inline for a tab whose only control is the search box; block for one that stacks
   * several selects beneath it. Not a style choice — three selects laid out inline wrap
   * into something unreadable at the width a table leaves.
   */
  direction = "inline",
  children,
}: {
  /** Every field this tab owns. Anything else in the URL is left alone. */
  fields: readonly string[];
  query: string;
  label?: string;
  placeholder?: string;
  direction?: "inline" | "block";
  /** Extra controls for this tab — a vendor select, a state filter. */
  children?: ReactNode;
}) {
  return (
    <FilterForm fields={fields}>
      <s-stack
        direction={direction}
        gap={direction === "inline" ? SPACE.item : SPACE.section}
        alignItems={direction === "inline" ? "end" : undefined}
      >
        <s-search-field
          name="q"
          label={label}
          labelAccessibilityVisibility={direction === "inline" ? "exclusive" : undefined}
          placeholder={placeholder}
          value={query}
        />
        {children}
        {direction === "inline" ? (
          <s-button type="submit">Search</s-button>
        ) : (
          // A block stack stretches its children, so the submit button was rendering the
          // full width of the card -- a Search button the size of the table it filters.
          // The row wrapper gives it back its own width without narrowing the fields
          // above it, which is what `alignItems` on the outer stack would have done.
          <s-stack direction="inline">
            <s-button type="submit">Search</s-button>
          </s-stack>
        )}
      </s-stack>
    </FilterForm>
  );
}
