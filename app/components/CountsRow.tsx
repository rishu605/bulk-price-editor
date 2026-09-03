import { formatCount } from "../lib/format/display";
import { HAIRLINE, PAD, SPACE } from "../lib/ui/spacing";

/**
 * A row of labelled figures, used for preview and catalogue summaries.
 *
 * ## Why these are tiles and not a row of text
 *
 * It used to be four unpadded boxes in an inline stack: a label, a number, a gap, repeat.
 * With no interior and no edge, "Will change 412 Already correct 9,081 Skipped 3" is one
 * run of text that the reader has to parse into pairs themselves — and these four numbers
 * are the summary of what a campaign is about to do to a live storefront. They are the
 * most important thing on the preview page and they were the least legible.
 *
 * Each figure now sits in its own bounded tile: padding so the pair has room, a hairline
 * so the boundary between one figure and the next is a line rather than an inference, and
 * tight rhythm inside so the label and the number read as one phrase.
 *
 * ## Equal columns, not an inline stack
 *
 * A grid rather than `direction="inline"`, because an inline stack sizes each tile to its
 * own content. "Clamped 0" then gets a third of the width of "Already correct 9,081", and
 * a row of unequal boxes reads as a ranking — the widest looks the most important, which
 * has nothing to do with what the numbers mean. Equal columns say these are four
 * measurements of one thing.
 *
 * The template is built from the item count rather than hardcoded, so a caller passing
 * three or five gets a full row rather than a gap on the end.
 *
 * ## Tiles that lead somewhere
 *
 * A figure on a dashboard is a question — "three need attention" is only useful if the
 * next click is the three. Where a caller gives an `href`, the whole tile becomes the
 * target rather than a link tucked under the number: the number is what a merchant is
 * aiming at, and a hit area smaller than the thing being read is a hit area people miss.
 *
 * Optional, because not every figure has a page behind it. "Variants: 3,669" on the
 * catalogue card is a fact, not a queue, and giving it a destination invents one.
 *
 * `s-clickable` rather than `s-link`: `ActionRow`'s vocabulary reserves blue for a word
 * inside a sentence, and this is a whole box.
 *
 * **One comma.** Polaris splits a responsive value on the comma to separate "when the
 * query matches" from "otherwise", so a `repeat(4, 1fr)` on either side of it takes its
 * own comma as that separator and the whole value stops parsing — falling back to `none`,
 * which stacks the tiles into a single column that looks like a deliberate layout rather
 * than a broken string. Spelling out `1fr 1fr 1fr 1fr` is the price of that.
 */
export interface CountItem {
  label: string;
  value: number;
  /** Where this figure leads, when it leads anywhere. */
  href?: string;
}

export function CountsRow({ items }: { items: CountItem[] }) {
  // `|| "1fr"` for the empty list: an empty template string leaves the responsive value
  // ending in a bare comma, which is the unparseable shape described above.
  const columns = items.map(() => "1fr").join(" ") || "1fr";

  return (
    <s-grid
      // Two up when the card gets narrow. Four tiles in a 400px column would be four
      // slivers, and a figure that wraps mid-number is worse than a second row.
      gridTemplateColumns={`@container (inline-size <= 600px) 1fr 1fr, ${columns}`}
      gap={SPACE.item}
    >
      {items.map((item) =>
        // Two shapes rather than one wrapped in a spare element: a `div` around the
        // non-linking tile would become the grid item, and the box inside it would size
        // to its content instead of filling the column — which is the unequal-width
        // failure this grid exists to prevent.
        item.href ? (
          <s-clickable
            key={item.label}
            href={item.href}
            accessibilityLabel={`${item.label}: ${formatCount(item.value)}`}
          >
            <Tile item={item} />
          </s-clickable>
        ) : (
          <Tile key={item.label} item={item} />
        ),
      )}
    </s-grid>
  );
}

/** The bounded figure itself, so the linking and non-linking cases cannot drift apart. */
function Tile({ item }: { item: CountItem }) {
  return (
    <s-box
      padding={PAD.card}
      borderWidth={HAIRLINE.borderWidth}
      borderStyle={HAIRLINE.borderStyle}
      borderColor={HAIRLINE.borderColor}
      borderRadius="base"
    >
      <s-stack gap={SPACE.tight}>
        <s-text color="subdued">{item.label}</s-text>
        <s-heading>{formatCount(item.value)}</s-heading>
      </s-stack>
    </s-box>
  );
}
