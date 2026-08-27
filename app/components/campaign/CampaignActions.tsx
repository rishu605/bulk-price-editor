/**
 * Apply, revert, resume and cancel.
 *
 * Lifted out of the page's aside and into the header, so the one action a merchant is
 * most likely to want is visible in every state without scrolling past a margin
 * analysis and a ledger to find it.
 */

import type { CampaignDetailProps } from "./props";

export function CampaignActions({ rollback, practice, lifecycle, fetcher, busy, canApply }: CampaignDetailProps) {
  return (
    <>
      <s-section heading="Actions">
        {practice ? (
          <s-banner tone="info">
            <s-paragraph>
              This is a practice campaign. The preview above is exactly what would
              happen, and nothing has been or will be written to your storefront.
              Create a real campaign with the same scope and rule when you are ready.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-stack gap="base">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="apply" />
            {/* Black only while it can actually be pressed. A partial run shows Resume
                as well, and this card was rendering two black buttons at once — one of
                them disabled, which is the loudest possible way to offer something that
                cannot be done. The primary follows what the lifecycle says is next. */}
            <s-button
              type="submit"
              variant={canApply ? "primary" : "secondary"}
              loading={busy || undefined}
              disabled={!canApply}
            >
              Apply to storefront
            </s-button>
          </fetcher.Form>

          {lifecycle.nextAction?.intent === "resume" ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="resume" />
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                Resume — retry the rows that did not complete
              </s-button>
            </fetcher.Form>
          ) : null}

          {rollback && !rollback.straightforward ? (
            // Deliberately not a button. There are edits to decide about, and a
            // one-click revert here would silently overwrite them -- the decision
            // belongs in the report, where the merchant can see what they are
            // choosing between.
            <s-paragraph>
              <s-text>
                {rollback.counts.drifted} variant
                {rollback.counts.drifted === 1 ? " has" : "s have"} been changed since
                this campaign set {rollback.counts.drifted === 1 ? "it" : "them"}.
                Review them above before reverting.
              </s-text>
            </s-paragraph>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="revert" />
              <s-button type="submit" tone="critical" loading={busy || undefined}>
                Revert
              </s-button>
            </fetcher.Form>
          )}
        </s-stack>

        <s-paragraph>
          <s-text>
            Reverting recomputes each price without this campaign. If another campaign
            still covers a variant, that campaign&rsquo;s price stays — it does not
            snap back to full price.
          </s-text>
        </s-paragraph>
      </s-section>
    </>
  );
}
