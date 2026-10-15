import type { ElementRef, Ref } from "react";

import type { BlastRadius } from "../../lib/campaigns/blast-radius";
import { SPACE } from "../../lib/ui/spacing";
import { Card } from "../Card";
import { Secondary } from "../Type";
import type { CampaignDetailProps } from "./props";

/**
 * The typed confirmation for a start nobody is watching (#1009).
 *
 * The scheduler and Shopify Flow start a campaign with nobody there to type "apply", so the
 * word is asked when the start is decided: dates saved in the editor or on this page, or the
 * campaign confirmed for Flow on its Overview tab. Each asks with this box, in the start
 * check's own sentence, which is what the server refuses with.
 */
export function StartConfirmationAsk({
  unconfirmed,
  radius,
  label,
  fieldRef,
}: {
  /** Why the start needs the word: `unconfirmedStart`'s sentence. */
  unconfirmed: string;
  /** The reach behind it, for the largest change's prices, which the sentence leaves out. */
  radius: BlastRadius | null;
  label: string;
  /** For a box read on click inside a modal, where there is no form to post it. */
  fieldRef?: Ref<ElementRef<"s-text-field">>;
}) {
  return (
    <s-banner tone="warning">
      <s-stack gap={SPACE.item}>
        <s-paragraph>{unconfirmed}</s-paragraph>
        {radius?.largest ? (
          <s-paragraph>
            Largest change: {radius.largest.title}, {radius.largest.before} to {radius.largest.after}.
          </s-paragraph>
        ) : null}
        <s-paragraph>
          The schedule and Shopify Flow start a campaign with nobody there to type{" "}
          <s-text type="strong">apply</s-text>, so it is asked now, and kept with the campaign.
        </s-paragraph>
        <s-text-field
          ref={fieldRef}
          name="confirmation"
          label={label}
          required
          details="Asked only over the typed-confirmation thresholds in Settings."
        />
      </s-stack>
    </s-banner>
  );
}

/**
 * "Scheduled and Flow starts" on the Overview tab: whether the scheduler and Flow may start
 * this campaign as it is now, and the box that confirms it when they may not.
 *
 * Shown only where there is something to say: a confirmation on record, or a campaign that
 * needs one. Never on practice or a cancelled campaign, which never start.
 */
export function StartConfirmationCard({ startConfirmation, preview, practice, state, fetcher, busy }: CampaignDetailProps) {
  const { confirmed, unconfirmed } = startConfirmation;
  if (practice || state === "CANCELLED" || (!confirmed && !unconfirmed)) return null;

  return (
    <Card heading="Scheduled and Flow starts">
      {confirmed ? (
        <s-paragraph>
          Confirmed by {confirmed.by}, {confirmed.at}: {confirmed.reach}.
          {unconfirmed ? null : " The schedule and Shopify Flow can start it while it reaches no further than that."}
        </s-paragraph>
      ) : null}
      {unconfirmed ? (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="confirm-start" />
          <s-stack gap={SPACE.item}>
            <StartConfirmationAsk unconfirmed={unconfirmed} radius={preview.confirm ?? null} label="Type apply to confirm it" />
            <s-stack direction="inline" gap={SPACE.item} justifyContent="end">
              <s-button type="submit" variant="secondary" loading={busy || undefined}>
                Confirm for scheduled and Flow starts
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      ) : null}
      <Secondary>
        Applying it from this page asks for the word itself, every time it is needed.
      </Secondary>
    </Card>
  );
}
