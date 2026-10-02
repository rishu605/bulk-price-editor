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
import { ScheduleButtons, ScheduleModals } from "./ScheduleControls";
import { ApplyConfirmation, APPLY_MODAL_ID } from "./ApplyConfirmation";
import { RevertConfirmation, REVERT_MODAL_ID } from "./RevertConfirmation";
import { SPACE } from "../../lib/ui/spacing";
import { formatScheduleInstant } from "../../lib/scheduling/window";
import { IN_FLIGHT } from "./useRunPolling";
import type { CampaignDetailProps } from "./props";

/** Links the "More actions" button to the menu it opens. */
const MORE_MENU_ID = "campaign-more-actions";

export function CampaignHeader({
  rollback,
  practice,
  preview,
  rule,
  scope,
  archived,
  notifyEmail,
  campaignId,
  needsAttention,
  scheduleText,
  lifecycle,
  fetcher,
  busy,
  canApply,
  keepers,
  keepersPending,
  heldEdits = 0,
  window,
  state,
  runs,
  timeZone,
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
        {/* Not rendered at all for a practice campaign — see above. While a run is writing,
            what it is doing takes the button's place (#793): a second Apply has nothing to
            do but stand down, and a black button beside "Applying" asked for one. */}
        {practice ? null : IN_FLIGHT.has(state) ? (
          <s-text color="subdued">{writing(runs, timeZone)}</s-text>
        ) : (
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
              // Not the obvious next step on a campaign held by edits made in Shopify:
              // applying writes over them. "Review the drift queue", beside it, is (#755).
              variant={canApply && heldEdits === 0 ? "primary" : "secondary"}
              loading={busy || undefined}
              disabled={!canApply || undefined}
              commandFor={APPLY_MODAL_ID}
              command="--show"
            >
              Apply to storefront
            </s-button>

            {/* Before it starts: move it, or stop it. Nothing else on the page could
                (#760), and Archive -- the only thing that looked like it might -- files it
                away and leaves it to run on its date. */}
            {window ? <ScheduleButtons busy={busy} /> : null}
          </>
        )}

        {lifecycle.nextAction?.intent === "drift" && heldEdits > 0 ? (
          // Where a held campaign's decision is made. The lifecycle has always named it as
          // the next step, but the header drew only Apply -- which writes over the edits
          // the drift queue was holding for a decision (#755).
          <s-button variant="primary" href="/app/prices/drift">
            {lifecycle.nextAction.label}
          </s-button>
        ) : null}

        {lifecycle.nextAction?.intent === "resume" ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="resume" />
            {/* Black, and Apply is not: a partial run's next step is finishing it. The
                two were both primary at once in the old card, one of them disabled,
                which is the loudest possible way to offer something that cannot be
                done. */}
            <s-button type="submit" variant="primary" loading={busy || undefined}>
              {lifecycle.nextAction.label}
            </s-button>
          </fetcher.Form>
        ) : null}

        {/* Only where there is something to revert -- which is exactly where the loader
            builds a rollback report. Rendered without one, Revert pointed at a dialog that
            was never drawn, and pressing it on a draft or a scheduled campaign did nothing
            at all (#749). */}
        {!rollback ? null : !rollback.straightforward ? (
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

        {/* Everything that files the campaign rather than prices it, behind one control.

            The row rendered up to six buttons at once — Apply, Resume, Revert or "Review
            N edited", Duplicate, Contact support, Archive — and three of those are about
            the campaign as a record. A merchant scanning for the one button that writes
            to a storefront had to read past them every time.

            Nothing that writes a price is ever in here. That is the rule, and
            `campaign-header.test.tsx` holds it: an overflow is where an action goes when
            it is *not* what the page is for, and a merchant who has to open a menu to
            find Apply has been given the wrong menu.

            Duplicate is not recurrence, which this app already has. Recurrence re-arms
            the same sale; Duplicate is how next month's different sale gets built out of
            last month's sale that worked. NA offers `Copy to new job` in place of
            recurrence; Sami offers both, and both is right.

            There is no delete anywhere, and that is deliberate rather than missing: the
            ledger hangs off this campaign's runs, so deleting the row would erase the
            record of every price we ever wrote for it. Archive keeps all of it and takes
            the campaign out of the list. `delete-guard.test.ts` holds the line.

            `command` as well as `commandFor`, which is the scar `HelpNote` records: in
            `polaris.js` the activator's click handler is built only when both are
            present, so `commandFor` alone renders a button that is focusable and inert —
            no error, no warning. */}
        <s-button
          variant="tertiary"
          icon="menu-horizontal"
          commandFor={MORE_MENU_ID}
          command="--toggle"
          loading={busy || undefined}
        >
          More actions
        </s-button>

        {/* Buttons only. Polaris' own types say of `s-menu`: "Only Button components are
            allowed as children of a Menu… Any other component placed here will be
            ignored" — so the two form posts that used to wrap their submits are
            `fetcher.submit` calls instead. A `<form>` in here would be dropped silently,
            which is the failure mode this app has been bitten by twice. */}
        <s-menu id={MORE_MENU_ID} accessibilityLabel="More actions for this campaign">
          <s-button
            icon="duplicate"
            onClick={() => fetcher.submit({ intent: "duplicate" }, { method: "post" })}
          >
            Duplicate
          </s-button>

          <s-button
            icon="archive"
            onClick={() =>
              fetcher.submit({ intent: archived ? "unarchive" : "archive" }, { method: "post" })
            }
          >
            {archived ? "Restore" : "Archive"}
          </s-button>

          {/* Only where the campaign is in a state a merchant might need help with. On a
              draft it would be a support link beside a form nobody has submitted yet; on
              Held or Partial it is beside the two states this product is *about*, and the
              ones whose questions are hardest to ask without a run id. */}
          {needsAttention ? (
            <s-button icon="chat" href={supportHref(campaignId)}>
              Contact support
            </s-button>
          ) : null}
        </s-menu>
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
          busy={busy}
          onConfirm={() => fetcher.submit({ intent: "revert" }, { method: "post" })}
        />
      ) : null}

      {/* Outside the row, because a modal is not an action. Inside `ActionRow` it
          was a third child of a row of buttons, and it put its own primary button in
          the middle of the header's — which the "at most one black button" rule
          reads, correctly, as two.

          `fetcher.submit` rather than a form, for the reason the menu above gives and
          `ApplyConfirmation`'s own button records: only an `s-button` may carry
          `slot="primary-action"`, so there is nowhere in a modal to put a form. */}
      {window && !practice ? (
        <ScheduleModals
          campaignName={preview.name}
          window={window}
          busy={busy}
          onSave={(fields) => fetcher.submit({ intent: "reschedule", ...fields }, { method: "post" })}
          onUnschedule={() => fetcher.submit({ intent: "unschedule" }, { method: "post" })}
          onCancel={() => fetcher.submit({ intent: "cancel-schedule" }, { method: "post" })}
        />
      ) : null}

      {practice ? null : (
        <ApplyConfirmation
          preview={preview}
          rule={rule}
          scope={scope}
          notifyEmail={notifyEmail}
          scheduleText={scheduleText}
          busy={busy}
          heldEdits={heldEdits}
          onConfirm={(confirmation) =>
            fetcher.submit({ intent: "apply", confirmation }, { method: "post" })
          }
        />
      )}
    </>
  );
}

/**
 * The support route, carrying the campaign.
 *
 * The run id is deliberately not in here. The campaign page already shows which run is
 * selected, and a link built from whichever run happened to be on screen would attach the
 * wrong one as often as the right one — support can ask, and a wrong id is worse than a
 * missing one.
 */
function supportHref(campaignId: string): string {
  return `/app/support?${new URLSearchParams({ campaign: campaignId, from: `/app/campaigns/${campaignId}` })}`;
}

/** The run statuses that are still writing. */
const LIVE_RUN = new Set(["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"]);

/**
 * What the header says while a run writes: when it started, or that the worker has yet to
 * pick it up -- a run handed over by #790 has no row until it does.
 */
function writing(runs: ReadonlyArray<{ status: string; startedAt: string | null }>, timeZone: string): string {
  const live = runs.find((run) => LIVE_RUN.has(run.status));
  const when = live?.startedAt
    ? `Started ${formatScheduleInstant(live.startedAt, timeZone)}`
    : "Waiting for the background worker";
  return `${when} · this page updates when it finishes`;
}
