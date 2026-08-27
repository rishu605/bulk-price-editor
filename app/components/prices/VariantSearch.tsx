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
      {direction === "inline" ? (
        <s-stack direction="inline" gap={SPACE.item} alignItems="end">
          <s-search-field
            name="q"
            label={label}
            labelAccessibilityVisibility="exclusive"
            placeholder={placeholder}
            value={query}
          />
          {children}
          <s-button type="submit">Search</s-button>
        </s-stack>
      ) : (
        // A grid, not a vertical stack.
        //
        // Stacked, every control took the full width of the card: a "Surface" select
        // holding the word "Every" rendered twelve hundred pixels wide. That is the
        // single most unstyled-looking thing in the app, and it is not a width problem
        // — the page is exactly as wide as it should be. It is a control that does not
        // know how much room it needs.
        //
        // The earlier comment here warned that three selects inline "wrap into
        // something unreadable". True of `s-stack direction="inline"`, which wraps
        // wherever it runs out; a grid places them in named columns and re-flows to one
        // column below 700px instead.
        //
        // `1fr 1fr 1fr`, never `repeat(3, 1fr)`: Polaris splits a responsive value on
        // the comma to separate the two branches, so a comma inside a value makes the
        // whole thing unparseable and it silently falls back to `none`.
        <s-stack gap={SPACE.section}>
          <s-grid
            gap={SPACE.section}
            gridTemplateColumns="@container (inline-size <= 700px) 1fr, 1fr 1fr 1fr"
          >
            <s-grid-item gridColumn="span 2">
              <s-search-field
                name="q"
                label={label}
                placeholder={placeholder}
                value={query}
              />
            </s-grid-item>
            {children}
          </s-grid>

          {/* Its own row, so the button keeps its natural width. A block stack stretches
              its children, which is how this rendered as a full-width submit bar. */}
          <s-stack direction="inline" gap={SPACE.item}>
            <s-button type="submit">Search</s-button>
          </s-stack>
        </s-stack>
      )}
    </FilterForm>
  );
}
