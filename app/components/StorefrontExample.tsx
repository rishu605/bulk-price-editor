import { SPACE } from "../lib/ui/spacing";
import type { DraftPreviewRow } from "../services/campaigns/draft-preview.server";

/**
 * One product, the way a customer will see it.
 *
 * The table below this answers "how many, and which?". This answers a different question,
 * asked earlier and by a different part of the brain: *did I mean −20% or ×0.20, and is
 * the strike-through going to look right?* Fifty rows set small answer the first badly and
 * the second not at all.
 *
 * NA puts exactly this beside its rule and it is the clearest thing in their app. RUBIX
 * does a weaker version with invented numbers — a "T-Shirt" at 100.00 that is in nobody's
 * catalogue — which teaches a merchant the arithmetic and nothing about their own shop.
 * This uses a real variant, at its real baseline, priced by the same `resolve()` as the
 * run.
 *
 * It is also the only place in this app, or any of the three competitors', where a
 * merchant sees what the customer sees before committing.
 */
export function StorefrontExample({
  row,
  /** Named when the shop has more than one, so "which price is this?" has an answer. */
  surface,
}: {
  row: DraftPreviewRow;
  surface?: string;
}) {
  // A compare-at above the price is what a storefront renders as a sale: the old price
  // struck through and a badge. Below or equal is not a sale and must not be dressed as
  // one — that is a claim about a discount that is not being given.
  const onSale = Boolean(row.afterCompareAt) && row.afterCompareAt !== row.after;

  return (
    <s-box padding={SPACE.item} borderRadius="base" background="subdued">
      <s-stack gap={SPACE.tight}>
        <s-text color="subdued" type="strong">
          On your storefront{surface ? ` · ${surface}` : ""}
        </s-text>

        <s-stack direction="inline" gap={SPACE.item} alignItems="center">
          {row.imageUrl ? <s-thumbnail src={row.imageUrl} alt="" size="base" /> : null}

          <s-stack gap={SPACE.tight}>
            <s-text>{row.title}</s-text>

            <s-stack direction="inline" gap={SPACE.tight} alignItems="center">
              <s-text type="strong">{row.after ?? "—"}</s-text>
              {/* `redundant`, not a CSS strike-through. Polaris documents this type for
                  exactly this case — "no longer accurate… one such use-case is discounted
                  prices" — and renders it as `<s>`, so a screen reader says so too. A line
                  drawn with CSS is a line only sighted merchants see. */}
              {onSale ? (
                <s-text color="subdued" type="redundant">
                  {row.afterCompareAt}
                </s-text>
              ) : null}
              {onSale ? <s-badge tone="critical">Sale</s-badge> : null}
            </s-stack>
          </s-stack>
        </s-stack>

        {/* Where the number came from, in one line. The strike-through is the campaign's
            compare-at policy, not the price it replaced, and a merchant who reads the
            two as the same thing will expect a revert to restore what is struck out. */}
        <s-text color="subdued">
          Priced from a baseline of {row.before ?? "—"}
          {row.live ? `, though the storefront currently shows ${row.live}` : ""}.
        </s-text>
      </s-stack>
    </s-box>
  );
}

/**
 * The row to show, or nothing.
 *
 * Deterministic, and that is the whole requirement: `previewDraft` returns rows ordered
 * changing, then already-correct, then skipped, so the first changing row is stable
 * across keystrokes. Picking at random — or picking "the most interesting" — would make
 * the card flicker between products while a merchant types a percentage, which is the
 * one thing an example must not do.
 *
 * Nothing when no row is changing: an example of a price that is not moving teaches the
 * opposite of what it is there to teach.
 */
export function exampleRowFrom(rows: DraftPreviewRow[]): DraftPreviewRow | null {
  return rows.find((row) => !row.unchanged && !row.skippedReason) ?? null;
}
