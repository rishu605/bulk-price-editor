import type { ReactNode } from "react";

/**
 * The thing a `@container` value is measured against.
 *
 * Eight layouts in this app choose their columns with a Polaris responsive value —
 * `"@container (inline-size <= 900px) 1fr, 1fr 22rem"` — and every one of them is
 * measured against nothing.
 *
 * A CSS container query resolves against the **nearest ancestor container**, and an
 * element only becomes one if something sets `container-type` on it. Polaris sets it in
 * exactly one place, which its own types spell out: "We place the container name of
 * `s-default` on every container… @implementation You must always have a CSS
 * `container-name` of `s-default` for this component" — the component being
 * `s-query-container`. No container, no match, so every value silently takes its
 * unmatched branch on every screen, at every width.
 *
 * ## Why this is the second attempt
 *
 * The first (#560) wrapped seven grids in one of these and was reverted within the hour:
 * the campaign editor's field grid came out as two columns of about 10px and 445px, with
 * "How should prices change?" wrapping to one character per line.
 *
 * The cause is in `polaris.js`, and it is one line:
 *
 *     s-query-container :host { display: grid; container-type: inline-size }
 *
 * **It is a grid, not a block.** Its child becomes a grid item in a single implicit
 * column, and `container-type: inline-size` adds size containment on top. Dropped into a
 * layout that sizes by content — a flex row, a grid track of `auto` — the wrapper has
 * nothing telling it how wide to be, so it takes its content's idea instead and the grid
 * inside it collapses. In a block context it fills the line box and everything behaves.
 *
 * So the rule this component exists to carry: **put it where its parent has already
 * decided the width.** A card's interior, a page's content area, a stack's child. Never
 * as an item in a row that is sizing itself, and never hoisted to cover several grids at
 * once — a grid measured against the page rather than against its own column is the
 * state this replaces.
 *
 * `query-container.test.tsx` holds both halves: every component carrying a `@container`
 * value has one, and none of them puts it somewhere it would collapse.
 */
export function QueryContainer({ children }: { children: ReactNode }) {
  return <s-query-container>{children}</s-query-container>;
}
