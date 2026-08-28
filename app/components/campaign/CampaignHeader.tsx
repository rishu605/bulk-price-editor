/**
 * What this campaign is doing, and what to do about it — on one row.
 *
 * The page opened with two cards above the tab bar: an `s-section` holding a status badge
 * and a line of schedule text, then `CampaignActions` rendering its own `s-section
 * heading="Actions"`. Two rectangles, the second titled after a *category of thing* rather
 * than after anything on the page, stacked above the tabs that are the real header. The
 * campaigns index stopped doing exactly this in #395 — "the row is the page header rather
 * than an almost-empty rectangle above it" — and this page was not touched.
 *
 * So: no card. Status on the left, the actions on the right, one row, above the tab bar
 * that draws its own rule under both. That is a header; the two boxes were furniture.
 *
 * ## Why the actions are not in the tab bar's action slot
 *
 * The campaigns index puts its one primary action there. This page has two or three, plus
 * a status badge and a schedule that have to sit beside them, and the slot is sized for a
 * button. A row above the bar holds the pair the merchant reads together — what state is
 * this in, and what can I do about it — without crowding five tabs into what is left.
 *
 * ## Which button is black
 *
 * At most one. The lifecycle decides: `canApply` is gated on the state and the guardrails,
 * not on whether there is anything to write — a campaign whose prices already match still
 * has to be applied to take ownership of them, and requiring rows left such a campaign
 * stuck in Draft forever, which also meant nothing would ever revert those prices.
 *
 * A practice campaign is never applicable and the button is not merely disabled: offering
 * a control that exists only to be refused undermines the promise the merchant was given
 * when they chose practice.
 */

import { ActionRow } from "../ActionRow";
import { SPACE } from "../../lib/ui/spacing";
import type { CampaignDetailProps } from "./props";

export function CampaignHeader({
  rollback,
  practice,
  scheduleText,
  lifecycle,
  fetcher,
  busy,
  canApply,
}: CampaignDetailProps) {
  return (
    <s-grid
      // The status takes the space, the actions take what they need. Centred, so the
      // badge and the buttons sit on one line whatever the schedule sentence wraps to.
      gridTemplateColumns="1fr auto"
      gap={SPACE.section}
      alignItems="center"
    >
      <s-stack direction="inline" gap={SPACE.item} alignItems="center">
        <s-badge tone={lifecycle.tone}>{lifecycle.label}</s-badge>
        {scheduleText ? <s-text color="subdued">{scheduleText}</s-text> : null}
      </s-stack>

      <ActionRow>
        {/* Not rendered at all for a practice campaign — see above. */}
        {practice ? null : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="apply" />
            <s-button
              type="submit"
              variant={canApply ? "primary" : "secondary"}
              loading={busy || undefined}
              disabled={!canApply || undefined}
            >
              Apply to storefront
            </s-button>
          </fetcher.Form>
        )}

        {lifecycle.nextAction?.intent === "resume" ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="resume" />
            {/* Black, and Apply is not: a partial run's next step is finishing it. The
                two were both primary at once in the old card, one of them disabled,
                which is the loudest possible way to offer something that cannot be
                done. */}
            <s-button type="submit" variant="primary" loading={busy || undefined}>
              Resume
            </s-button>
          </fetcher.Form>
        ) : null}

        {rollback && !rollback.straightforward ? (
          // Deliberately not a revert button. There are edits to decide about, and a
          // one-click revert here would silently overwrite them.
          //
          // It was a *sentence* — "Review them above before reverting" — which stopped
          // being true when the report moved into a tab in #345: there is nothing above.
          // A link to the tab is the same refusal, pointed at where the decision is.
          <s-button variant="secondary" href="?tab=revert">
            Review {rollback.counts.drifted} edited before reverting
          </s-button>
        ) : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="revert" />
            <s-button type="submit" tone="critical" loading={busy || undefined}>
              Revert
            </s-button>
          </fetcher.Form>
        )}
      </ActionRow>
    </s-grid>
  );
}
