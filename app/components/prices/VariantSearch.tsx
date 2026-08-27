import type { ReactNode } from "react";

import { FilterForm } from "../FilterForm";

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
      <s-stack direction={direction} gap="base">
        <s-search-field
          name="q"
          label={label}
          labelAccessibilityVisibility={direction === "inline" ? "exclusive" : undefined}
          placeholder={placeholder}
          value={query}
        />
        {children}
        <s-button type="submit">Search</s-button>
      </s-stack>
    </FilterForm>
  );
}
