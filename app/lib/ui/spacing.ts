/**
 * The app's spatial and typographic scale, in one place.
 *
 * ## Why this file exists
 *
 * Before it, the app used `gap="base"` fifty-four times, any other gap thirteen times,
 * and `padding` twice in the entire codebase. Every relationship on the screen — a page
 * and its sections, a section and its blocks, a button and the text beside it — was
 * rendered at the same distance. That is not a subtle flaw. Spacing is the only signal a
 * reader has for *what belongs to what*, so a single flat rhythm tells them nothing, and
 * a UI that tells you nothing about its own structure is what "unstyled" actually means.
 *
 * The fix is not more space. It is **fewer, more different** spaces. Three rhythms that
 * are visibly distinct beat nine that are nearly identical, because the eye reads the
 * ratio, not the pixel count.
 *
 * ## The scale
 *
 * Polaris exposes one size scale for both `gap` and `padding`, ascending:
 *
 * ```
 * small-500 … small-100  small  base  large  large-100 … large-500
 * ```
 *
 * Note the ordering trap: `small` is *larger* than `small-100`, and `large-100` is
 * *larger* than `large`. The numbered steps move away from the middle, so `small-500` is
 * the smallest value on the scale and `large-500` the biggest.
 *
 * This app uses four of them, each roughly double the one below it. The doubling is the
 * point: two adjacent steps on the Polaris scale are not reliably distinguishable, and a
 * distinction a merchant cannot see is a distinction that is not there.
 *
 * | Rhythm    | Token         | Separates                                    |
 * |-----------|---------------|----------------------------------------------|
 * | Page      | `large-200`   | top-level sections on a page                  |
 * | Section   | `base`        | blocks inside one section                     |
 * | Item      | `small-100`   | related controls, list rows, badge and label  |
 * | Tight     | `small-300`   | parts of one thing — a label over its figure  |
 *
 * `base` stays the section rhythm on purpose. It is what most of those fifty-four
 * existing `gap="base"` uses already meant, so the routes that have not been revisited
 * yet stay correct rather than becoming subtly wrong while this lands.
 *
 * That grace period is over. `spacing.test.ts` now rejects a hardcoded `gap` or `padding`
 * anywhere in `app/`, rather than in the seven shared primitives it started with. The
 * argument for widening it is the thing the literal hides: `gap="base"` is *correct* where
 * section rhythm was meant, which is why it survived four design passes — and it is
 * indistinguishable in a diff from the places that meant **item** rhythm and got section
 * rhythm instead, so a row of buttons rendered as a list of unrelated blocks. A rule that
 * covers seven files cannot see that; there is nothing to compare against.
 *
 * ## Applying it
 *
 * - **Page rhythm** belongs to `PageShell` and nothing else. A route should never set the
 *   distance between its own sections; the shell owns that, which is why every page in
 *   the app has the same one.
 * - **Section rhythm** goes between blocks that are separately readable inside a card: a
 *   filter form and the table it filters, a paragraph and the button under it. Stacked
 *   form fields also take section rhythm, not item rhythm — each field carries its own
 *   label above it, and item rhythm leaves the label of one field crowding the field
 *   above it.
 * - **Item rhythm** goes between controls that share a baseline and read as one row:
 *   Previous / count / Next, a badge and the sentence next to it, tabs.
 * - **Tight rhythm** is for parts of a single object. If the two things would be read
 *   aloud as one phrase — "Will change: 412" — they get tight rhythm.
 *
 * ## Padding
 *
 * `s-section` accepts only `base` or `none`; there is no finer control and none is
 * needed, because a section is a card and a card has one interior. `none` is for content
 * that must reach the card's edge — a full-bleed table — and nothing else.
 *
 * `s-box` takes the whole scale. It is used two ways here, and they should not be
 * confused: a box with `PAD.card` plus a border and radius is *a card inside a card* (a
 * stat tile, a checklist step) and should be used sparingly; a box with `PAD.control` is
 * just a padded run of content (a tab, a chip) and carries no chrome of its own.
 *
 * ## Typography
 *
 * Polaris gives `s-heading` no size prop. Hierarchy comes from *which element you reach
 * for*, not from a size attribute, so the rule has to be about placement:
 *
 * - **Page title** — the `heading` prop on `PageShell`. Exactly one per page. Never an
 *   `s-heading` at the top of a route; that renders a second, competing title.
 * - **Section title** — the `heading` prop on `s-section`. Not a child `s-heading`:
 *   the prop is what lets Polaris level the document outline correctly.
 * - **Sub-block title** — a bare `s-heading` inside a section, for a block that needs a
 *   name but does not deserve a card of its own. This is the only place `s-heading`
 *   should appear, plus the figure in a stat tile, where the number *is* the heading.
 * - **Body copy** — `s-paragraph`. It is a block element and brings its own leading.
 *   Wrapping a bare `s-text` in an `s-paragraph` adds nothing unless the text needs its
 *   own tone or colour.
 * - **`s-text type="strong"`** — emphasis *within* a line: the value in a label/value
 *   pair, the name of a row, the tab you are on. It is not a small heading, and a strong
 *   run of text on its own line is a heading written the wrong way.
 * - **`s-text color="subdued"`** — supporting text that is true but not what the eye
 *   should land on: the label above a figure, a reference id, a hint under a control,
 *   "51–100 of 3,412". Never on anything actionable.
 * - **`s-text tone="…"`** — reserved for *meaning*, not for emphasis: `success`,
 *   `warning`, `critical`, `caution`, `info`. In particular `tone="neutral"` is not a
 *   way to spell "quieter" — it says "this has no status", which is different, and the
 *   app had been using it where `color="subdued"` was meant. (There is no
 *   `tone="subdued"`; `subdued` is a colour, and passing it as a tone silently does
 *   nothing.)
 * - **Figures** get `fontVariantNumeric="tabular-nums"` wherever the number changes in
 *   place — a paging count, a live total. Proportional digits make the surrounding text
 *   jump every time the value updates.
 */

/**
 * Polaris' size scale, ascending.
 *
 * Restated here rather than imported: `@shopify/polaris-types` declares `SizeKeyword`
 * internally and does not export it, and a `satisfies` check against the real union is
 * worth more than the DRY. If Polaris ever adds a step, the constants below still
 * typecheck against the JSX props, which is where it would actually matter.
 */
export type Space =
  | "small-500"
  | "small-400"
  | "small-300"
  | "small-200"
  | "small-100"
  | "small"
  | "base"
  | "large"
  | "large-100"
  | "large-200"
  | "large-300"
  | "large-400"
  | "large-500";

/** The same scale, plus the "no padding at all" case that only padding has. */
export type Padding = Space | "none";

/**
 * The four rhythms, largest to smallest.
 *
 * Ordered here the way they are ordered on screen, so the gaps between them are visible
 * in the source too. Each step is about double the last.
 */
export const SPACE = {
  /** Between top-level sections. Owned by `PageShell`; routes do not set this. */
  page: "large-200",
  /** Between separately readable blocks inside one section, and between stacked fields. */
  section: "base",
  /** Between controls that read as one row, and between rows of a short list. */
  item: "small-100",
  /** Between parts of a single object — a label and the figure it names. */
  tight: "small-300",
} as const satisfies Record<string, Space>;

/**
 * Interiors.
 *
 * Deliberately short. Padding is where a design gets away from itself fastest, and four
 * named interiors cover everything this app renders.
 */
export const PAD = {
  /** An `s-section`'s interior, and an `s-box` standing in for a card. */
  card: "base",
  /** A padded run of content with no chrome: a tab, a chip, a table cell stand-in. */
  control: "small-100 base",
  /** Vertical breathing room around a block that is mostly empty — an empty state. */
  block: "large-200",
  /** Content that must reach the card's edge. A full-bleed table, and little else. */
  flush: "none",
} as const;

/**
 * How far `s-page` insets its own contents.
 *
 * Not one of the four rhythms, and deliberately separate from `PAD.card` even though the
 * value is the same today: this is not a decision about how much room something needs, it
 * is a number belonging to Polaris that two of our components have to match. `PageShell`'s
 * back link and `SectionTabs`' bar both render *outside* `s-page` and have to line up with
 * the heading and the card below them.
 *
 * If the four rhythms are ever retuned, this must not move with them — it moves when
 * Polaris moves. Naming it is how those two facts stay separable.
 */
export const PAGE_INSET = "base" satisfies Space;

/**
 * The hairline used for tiles and sub-navigation rules.
 *
 * Grouped as one object because a border is three props that must agree, and only two of
 * them have useful defaults. A width set on its own inherits the default colour `base`,
 * which is heavier than a divider wants — a row of stat tiles outlined in it reads as a
 * spreadsheet rather than as grouping. Spreading one constant is how the three stay
 * together.
 */
export const HAIRLINE = {
  borderWidth: "base",
  borderStyle: "solid",
  borderColor: "subdued",
} as const;
