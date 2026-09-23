import { formatAgo, formatCount } from "../lib/format/display";
import { SPACE } from "../lib/ui/spacing";
import { RUN_TONE, toneFor } from "./tone";

/**
 * The last thing the app did to the storefront.
 *
 * This is the sentence a merchant opens the dashboard to read, and it used to be an
 * actual sentence: *Last run: apply of "Summer sale" — completed, 412 verified on
 * 27/08/2026, 12:40:38.* Everything is in there, in the order the code happened to have
 * it, and the two things being looked for — did it go cleanly, and was that recently —
 * are the fifth and last words of a clause.
 *
 * So the outcome is a toned badge on the left, where a status belongs, and what follows
 * is the campaign and then the detail. `PARTIAL` is a warning and never a success, per
 * `RUN_TONE` — a run that did not verify every row is the exact state this product exists
 * to make visible.
 *
 * ## What the restructure changed
 *
 * It was a bordered, padded box holding a three-column grid, sitting inside a `Card` that
 * is already a bordered surface. Two things were wrong with that.
 *
 * The box was the "boxes in boxes" shape `CountsRow` and `OnboardingCard` both carry a
 * paragraph about. Inside a card, a second border does not add structure; it adds a
 * frame around one of the card's three parts and makes that part look like a different
 * kind of thing.
 *
 * And the grid had the `UpcomingCampaigns` defect: three cells per run flowing into a
 * container query's two-column branch, so "View campaign" wrapped onto its own row
 * underneath the badge, in the empty column. That is what it did on a real dashboard —
 * correct at full width, wrong at the width the card actually renders at beside an aside.
 *
 * Both are gone, and so is the separate link. **The campaign's name is the link**, which
 * is what `UpcomingCampaigns` already does two cards away, so the dashboard now has one
 * way of offering a campaign rather than two. It also removes the third cell, which is
 * what made the wrap possible at all — the layout is two columns at every width and has
 * no narrow branch left to get wrong.
 */
export function LastRunSummary({
  run,
  now,
  timeZone,
}: {
  run: {
    kind: string;
    status: string;
    verified: number;
    failed: number;
    finishedAt: string | null;
    campaignId: string;
    campaignName: string;
  };
  now: string;
  timeZone: string;
}) {
  return (
    // `start`, not `center`: the badge belongs beside the campaign's name, which is the
    // first line. Centred against a two-line block it floats between them, pointing at
    // neither.
    <s-grid gridTemplateColumns="auto 1fr" gap={SPACE.item} alignItems="start">
      <s-badge tone={toneFor(RUN_TONE, run.status)}>{sentence(run.status)}</s-badge>

      <s-stack gap={SPACE.tight}>
        <s-link href={`/app/campaigns/${run.campaignId}`}>{run.campaignName}</s-link>
        <s-text color="subdued">
          {run.kind.toLowerCase()} · {formatCount(run.verified)} verified
          {run.failed > 0 ? `, ${formatCount(run.failed)} failed` : ""}
          {run.finishedAt ? ` · ${formatAgo(run.finishedAt, now, timeZone)}` : " · still running"}
        </s-text>
      </s-stack>
    </s-grid>
  );
}

/** `COMPLETED` is a database value; "Completed" is a word. */
function sentence(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
