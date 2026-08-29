import { formatCount } from "../../lib/format/display";
import { SPACE } from "../../lib/ui/spacing";
import type { KeepersAfterRevert } from "../../services/campaigns/keepers.server";

/**
 * The modal's id, and the handle the header's button opens it by.
 *
 * A literal, for the reason `ApplyConfirmation` gives: `commandFor` is typed
 * `Lowercase<string>` because HTML ids match case-sensitively, and an id assembled at
 * runtime is a button that silently opens nothing.
 */
export const REVERT_MODAL_ID = "revert-confirmation";

/**
 * What reverting actually does, beside the button that does it.
 *
 * The Revert **tab** already explains the recompute well, and a merchant who opens it is
 * not the one at risk. The header button is — it is the one pressed by somebody who has
 * decided to end a sale and is not expecting a lesson — and it posted straight through.
 * Exactly the shape of `blastRadius`, which has existed since the preview was written and
 * only ever appeared inside a tab.
 *
 * The words are `docs/help/concepts/revert.md`'s, because that page makes the argument
 * properly: a jacket at £100, a summer sale taking it to £80, clearance taking it to £70
 * — end the summer sale and restoring "what it was before" gives £100, while the right
 * answer is £70. Every competitor restores. Ours is the only one that can name the
 * campaign still holding the variant, and it does.
 */
export function RevertConfirmation({
  campaignName,
  counts,
  keepers,
  pending,
  children,
}: {
  campaignName: string;
  /** From the rollback report the page already has. */
  counts: { total: number; drifted: number; deleted: number };
  /** Asked for when the modal opens, because answering means planning the scope again. */
  keepers: KeepersAfterRevert | null;
  pending: boolean;
  /** The submit, carrying `slot="primary-action"` itself. */
  children: React.ReactNode;
}) {
  return (
    <s-modal id={REVERT_MODAL_ID} heading={`Revert ${campaignName}?`}>
      <s-stack gap={SPACE.section}>
        {/* The sentence, first, because it is the thing most likely to be wrong in a
            merchant's head — every other app in this category restores a saved price. */}
        <s-paragraph>
          <s-text>
            Reverting does not put the old prices back. It works out what each price should
            be now, with this campaign removed, and writes that.
          </s-text>
        </s-paragraph>

        <s-stack gap={SPACE.item}>
          <s-paragraph>
            <s-text type="strong">{formatCount(counts.total)}</s-text>{" "}
            <s-text>
              {counts.total === 1 ? "variant is" : "variants are"} priced by this campaign.
            </s-text>
          </s-paragraph>

          {counts.drifted > 0 ? (
            <s-paragraph>
              <s-text tone="caution">
                {formatCount(counts.drifted)} of them have been changed since this campaign
                set them. Open the Revert tab to choose which of those to leave alone —
                reverting from here rewrites all of them.
              </s-text>
            </s-paragraph>
          ) : null}

          {counts.deleted > 0 ? (
            <s-paragraph>
              <s-text color="subdued">
                {formatCount(counts.deleted)}{" "}
                {counts.deleted === 1 ? "was" : "were"} deleted in Shopify. Nothing is
                written for {counts.deleted === 1 ? "it" : "them"}.
              </s-text>
            </s-paragraph>
          ) : null}
        </s-stack>

        {/* The half no competitor can render: not "some prices may not return to normal",
            but which campaign holds which variants, by name. */}
        {pending ? (
          <s-paragraph>
            <s-text color="subdued">Working out what the prices would become…</s-text>
          </s-paragraph>
        ) : null}

        {keepers && keepers.keepers.length > 0 ? (
          <s-banner tone="info">
            <s-paragraph>
              <s-text type="strong">Not everything goes back to its baseline.</s-text>
            </s-paragraph>
            {keepers.keepers.map((keeper) => (
              <s-paragraph key={keeper.campaignId}>
                <s-text>
                  {keeper.name} still covers {formatCount(keeper.variants)}{" "}
                  {keeper.variants === 1 ? "variant" : "variants"}, so{" "}
                  {keeper.variants === 1 ? "it keeps" : "they keep"} that campaign&rsquo;s
                  price rather than returning to the baseline.
                </s-text>
              </s-paragraph>
            ))}
          </s-banner>
        ) : null}

        {keepers && keepers.keepers.length === 0 && !pending ? (
          <s-paragraph>
            <s-text color="subdued">
              No other campaign covers these variants, so every one of them returns to its
              baseline.
            </s-text>
          </s-paragraph>
        ) : null}
      </s-stack>

      <s-button slot="secondary-actions" commandFor={REVERT_MODAL_ID} command="--hide">
        Cancel
      </s-button>
      {children}
    </s-modal>
  );
}
