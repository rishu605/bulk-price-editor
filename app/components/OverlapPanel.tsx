import { formatCount } from "../lib/format/display";
import { SPACE } from "../lib/ui/spacing";
import type { DraftOverlap } from "../services/campaigns/draft-preview.server";
import { Secondary } from "./Type";

/**
 * What this campaign meets, and who keeps it.
 *
 * The single thing this app can say that none of the three competitors can.
 *
 * RUBIX puts this in the aside of its editor, above everything else, as a warning:
 *
 * > Do not create a 2nd task that target the same products **without reverting** the 1st
 * > task, because it will mess up the price.
 *
 * and its FAQ works the arithmetic through — 30% off, then 50% off without reverting,
 * leaves a $1000 product at $350 for ever, because "initial price" means whatever the
 * price happened to be when the second task started. NA and Sami have the same fault and
 * say nothing at all.
 *
 * We resolve overlap by priority and revert by recomputing, so the honest rendering is
 * not a warning. It is a statement of what will happen, from the resolver that will do
 * it — which is why the counts come out of the same `planRun` as the preview beside them
 * rather than from a second query that could disagree.
 *
 * Nothing renders when nothing overlaps. A panel that says "no overlaps" on every draft
 * is a panel a merchant stops reading before the one that matters.
 */
export function OverlapPanel({ overlaps }: { overlaps: DraftOverlap[] }) {
  if (overlaps.length === 0) return null;

  const total = overlaps.reduce((sum, overlap) => sum + overlap.variants, 0);

  return (
    <s-banner tone="info">
      <s-stack gap={SPACE.tight}>
        <s-paragraph>
          <s-text type="strong">
            {formatCount(total)} {total === 1 ? "variant" : "variants"} in this scope{" "}
            {total === 1 ? "is" : "are"} already priced by another campaign.
          </s-text>
        </s-paragraph>

        {overlaps.map((overlap) => (
          <s-paragraph key={overlap.campaignId}>
            <s-text>
              <s-link href={`/app/campaigns/${overlap.campaignId}`}>{overlap.name}</s-link>{" "}
              {overlap.variants === 1
                ? "keeps it"
                : `keeps ${formatCount(overlap.variants)} of them`}{" "}
              &mdash; it outranks this campaign. Raise this campaign&rsquo;s priority above{" "}
              {overlap.priority} to take {overlap.variants === 1 ? "it" : "them"}.
            </s-text>
          </s-paragraph>
        ))}

        {/* The half a competitor cannot write. Their revert restores a number, so the
            order campaigns are reverted in changes the result; ours recomputes without
            the campaign, so it does not. */}
        <Secondary>
          Campaigns never stack. Each variant is priced by exactly one of them, and
          reverting either recomputes the rest from their baselines rather than
          restoring a saved price — so the order you revert in does not matter.
        </Secondary>
      </s-stack>
    </s-banner>
  );
}
