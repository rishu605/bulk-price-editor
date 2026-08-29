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
import { ApplyConfirmation, APPLY_MODAL_ID } from "./ApplyConfirmation";
import { RevertConfirmation, REVERT_MODAL_ID } from "./RevertConfirmation";
import { SPACE } from "../../lib/ui/spacing";
import type { CampaignDetailProps } from "./props";

export function CampaignHeader({
  rollback,
  practice,
  preview,
  rule,
  scope,
  archived,
  scheduleText,
  lifecycle,
  fetcher,
  busy,
  canApply,
  keepers,
  keepersPending,
}: CampaignDetailProps) {
  return (
    <>
    <s-grid
      // The status takes the space, the actions take what they need. Centred, so the
      // badge and the buttons sit on one line whatever the schedule sentence wraps to.
      gridTemplateColumns="1fr auto"
      gap={SPACE.section}
      alignItems="center"
    >
      <s-stack direction="inline" gap={SPACE.item} alignItems="center">
        <s-badge tone={lifecycle.tone}>{lifecycle.label}</s-badge>
        {/* Beside the lifecycle badge and not instead of it. An archived campaign that
            is still ACTIVE still has prices live on the storefront, and a page that
            replaced one badge with the other would be hiding the half that matters. */}
        {archived ? <s-badge tone="neutral">Archived</s-badge> : null}
        {scheduleText ? <s-text color="subdued">{scheduleText}</s-text> : null}
      </s-stack>

      <ActionRow>
        {/* Not rendered at all for a practice campaign — see above. */}
        {practice ? null : (
          <>
            {/* Opens the confirmation rather than submitting.
                 *
                 * The button used to post straight from here, which made this the one
                 * place in the app where a price change happened with nothing in between.
                 * Our two-step shape — draft, then apply — was already safer than any of
                 * the three competitors, two of which have no confirmation at all; what
                 * was missing was the sentence saying what is about to happen.
                 *
                 * Still disabled when the campaign cannot be applied: opening a modal to
                 * be told no is worse than a button that says so. */}
            <s-button
              type="button"
              variant={canApply ? "primary" : "secondary"}
              loading={busy || undefined}
              disabled={!canApply || undefined}
              commandFor={APPLY_MODAL_ID}
              command="--show"
            >
              Apply to storefront
            </s-button>

          </>
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
          // Opens the confirmation. The Revert *tab* already explains the recompute
          // well, and a merchant who opens it is not the one at risk — this is the
          // button pressed by somebody who has decided to end a sale and is not
          // expecting a lesson.
          <s-button
            type="button"
            tone="critical"
            loading={busy || undefined}
            commandFor={REVERT_MODAL_ID}
            command="--show"
          >
            Revert
          </s-button>
        )}

        {/* Copy it and file it away. Both tertiary, and last: they are about the campaign
            as a record rather than about the prices, so they must not compete with the
            one button that writes to a storefront.

            Duplicate is not recurrence, which this app already has. Recurrence re-arms
            *this* campaign for its next occurrence and keeps one history; duplicate is
            how next month's different sale gets built out of last month's sale that
            worked. NA offers `Copy to new job` in place of recurrence; Sami offers both,
            and both is right.

            There is no delete anywhere, and that is deliberate rather than missing: the
            ledger hangs off this campaign's runs, so deleting the row would erase the
            record of every price we ever wrote for it. Archive keeps all of it and takes
            the campaign out of the list. `delete-guard.test.ts` holds the line. */}
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="duplicate" />
          <s-button type="submit" variant="tertiary" icon="duplicate" loading={busy || undefined}>
            Duplicate
          </s-button>
        </fetcher.Form>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value={archived ? "unarchive" : "archive"} />
          <s-button type="submit" variant="tertiary" icon="archive" loading={busy || undefined}>
            {archived ? "Restore" : "Archive"}
          </s-button>
        </fetcher.Form>
      </ActionRow>
    </s-grid>

      {/* Asked for when the modal opens, not on page load: answering means planning the
          whole scope again with this campaign excluded, and most visits to a campaign
          never press Revert. Putting it in the loader would be #468 in a new place. */}
      {rollback && rollback.straightforward ? (
        <RevertConfirmation
          campaignName={preview.name}
          counts={rollback.counts}
          keepers={keepers}
          pending={keepersPending}
        >
          <fetcher.Form method="post" slot="primary-action">
            <input type="hidden" name="intent" value="revert" />
            <s-button type="submit" tone="critical" loading={busy || undefined}>
              Revert now
            </s-button>
          </fetcher.Form>
        </RevertConfirmation>
      ) : null}

      {/* Outside the row, because a modal is not an action. Inside `ActionRow` it
          was a third child of a row of buttons, and it put its own primary button in
          the middle of the header's — which the "at most one black button" rule
          reads, correctly, as two. */}
      {practice ? null : (
      <ApplyConfirmation
        preview={preview}
        rule={rule}
        scope={scope}
        scheduleText={scheduleText}
      >
        <fetcher.Form method="post" slot="primary-action">
          <input type="hidden" name="intent" value="apply" />
          <s-button type="submit" variant="primary" loading={busy || undefined}>
            Apply now
          </s-button>
        </fetcher.Form>
      </ApplyConfirmation>
      )}
    </>
  );
}
