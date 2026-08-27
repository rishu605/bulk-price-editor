import type { ReactNode } from "react";

import { SPACE } from "../lib/ui/spacing";

/**
 * Form fields laid out in columns, so a control is the size of what it holds.
 *
 * A Polaris field in a block stack takes the full width of its card, whatever it
 * contains. A "Vendor" select holding one word, a "Tag" select holding one word and a
 * "Collection" select holding one word therefore rendered as three twelve-hundred-pixel
 * bars stacked on top of each other.
 *
 * That is the single most unstyled-looking thing in this app, and it is not a width
 * problem — the page is exactly as wide as it should be. It is a control that does not
 * know how much room it needs, and widening the page makes it worse.
 *
 * Fields carry no width prop, so the fix has to be layout.
 *
 * Two columns rather than three: these are labelled fields, not filter chips, and a
 * label plus a select needs enough room to avoid the label wrapping onto two lines,
 * which costs more than the space saved. Below 700px it becomes one column — a phone
 * showing two columns of half-width selects is worse than a stack.
 */
export function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <s-grid
      gap={SPACE.section}
      // One comma. Polaris splits a responsive value on it to separate "when the query
      // matches" from "otherwise", so `repeat(2, 1fr)` is unparseable and falls back to
      // `none` — which stacks everything full width again, i.e. looks exactly like the
      // bug this component exists to fix.
      gridTemplateColumns="@container (inline-size <= 700px) 1fr, 1fr 1fr"
    >
      {children}
    </s-grid>
  );
}

/**
 * A field that needs the whole row.
 *
 * Checkboxes and anything with a sentence attached: a checkbox is a tick and a label,
 * not a field, so a column sized for a select leaves it stranded in white space with its
 * text wrapping under the box.
 */
export function FullRow({ children }: { children: ReactNode }) {
  return <s-grid-item gridColumn="span 2">{children}</s-grid-item>;
}
