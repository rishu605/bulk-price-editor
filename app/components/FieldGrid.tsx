import type { ReactNode } from "react";

import { QueryContainer } from "./QueryContainer";
import { SPACE } from "../lib/ui/spacing";

/**
 * How much room a control needs, decided by what it holds.
 *
 * Polaris fields take no width prop and fill whatever contains them, and since the app
 * went full width that container is a ~970px card. So Diagnostics asked for a
 * thirteen-character reference in a box wide enough for a paragraph, Feedback offered
 * three short options in a select a metre long, and the guardrail percentages —
 * two-digit numbers — got half a page each.
 *
 * A control that is four times the size of its content does not read as roomy. It reads
 * as unfinished, because the one thing a form is meant to tell you before you type is how
 * much you are expected to type.
 *
 * Three widths, and the names are about content rather than pixels so a caller has to
 * answer the right question. `EmptyState` already caps its prose at 520px on the same
 * argument; this is that idea applied to input.
 */
export const FIELD = {
  /** A number, a code, an id: `25`, `ANC-K3M2-P7QR`. */
  short: "260px",
  /** A name, a select, an email — one line of ordinary language. */
  medium: "420px",
  /** Something genuinely long: a message, a pasted list. Still not the whole card. */
  long: "640px",
} as const;

/**
 * One control, at the width of what it holds.
 *
 * A wrapper rather than a prop because Polaris fields have no width of their own — the
 * same reason `FieldGrid` below is a grid. Wrapping is also what makes the intent
 * visible in the JSX: `<Field width="short">` next to a reference id says something a
 * bare field cannot.
 *
 * This fixes more than the look. Diagnostics put its reference field and its Find button
 * in an inline stack, commented as "the field and its button are one control" — and the
 * field took the full row, so the button wrapped underneath and the two have never been
 * one control on screen. Give the field a width and the row is a row.
 */
export function Field({
  width,
  children,
}: {
  width: keyof typeof FIELD;
  children: ReactNode;
}) {
  // `inlineSize`, not `maxInlineSize`. A maximum is only a ceiling, and in an inline
  // stack — which is exactly where Diagnostics needs this — the box shrinks to its
  // content instead, so an empty text field rendered 68px wide. A definite width with
  // `maxInlineSize="100%"` gives the field its size and still lets it shrink below that
  // on a narrow container rather than overflowing.
  return (
    <s-box inlineSize={FIELD[width]} maxInlineSize="100%">
      {children}
    </s-box>
  );
}

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
    <QueryContainer>
    <s-grid
      gap={SPACE.section}
      // Capped, for the reason `FIELD` exists. Two equal columns of a 970px card are
      // ~470px each, which is better than one 970px bar and still four times what a
      // percentage needs. Capping the grid rather than each field keeps the two columns
      // the same width, so the labels down each side stay in line -- fields sized
      // individually inside a grid would be tidy on their own and ragged together.
      maxInlineSize="720px"
      // One comma. Polaris splits a responsive value on it to separate "when the query
      // matches" from "otherwise", so `repeat(2, 1fr)` is unparseable and falls back to
      // `none` — which stacks everything full width again, i.e. looks exactly like the
      // bug this component exists to fix.
      gridTemplateColumns="@container (inline-size <= 700px) 1fr, 1fr 1fr"
    >
      {children}
    </s-grid>
    </QueryContainer>
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
