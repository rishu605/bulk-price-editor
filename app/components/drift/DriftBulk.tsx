import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

import { formatCount } from "../../lib/format/display";
import { prices, type DriftChoice } from "../../lib/drift/batch";
import { SPACE } from "../../lib/ui/spacing";
import { ActionRow } from "../ActionRow";
import { Caption, Secondary } from "../Type";

/**
 * One decision over every drifted price the queue's filters match (#822).
 *
 * The queue offered three buttons per row, fifteen rows at a time: 1,113 drifted prices
 * were 1,113 clicks while the campaign stayed Held. These are the same three decisions,
 * in the same words and with the same emphasis as the row's, over the whole filtered set
 * -- each behind a dialog that names the count and the campaign before anything changes.
 */

/**
 * Each decision's dialog id. Literals, for the reason `ApplyConfirmation` gives:
 * `commandFor` is typed `Lowercase<string>`, and an id assembled at runtime is a button
 * that silently opens nothing.
 */
const MODAL = {
  adopt: "drift-bulk-adopt",
  reassert: "drift-bulk-reassert",
  ignore: "drift-bulk-ignore",
} as const satisfies Record<DriftChoice, string>;

/** "Keep" is the one that changes what future campaigns compute from, as on each row. */
const BULK_CHOICES = [
  { value: "adopt", tone: "critical" },
  { value: "reassert", tone: "auto" },
  { value: "ignore", tone: "auto" },
] as const satisfies readonly { value: DriftChoice; tone: "critical" | "auto" }[];

/** The button that opens a decision's dialog, and the dialog's own: they say the same thing. */
function bulkLabel(choice: DriftChoice, count: number): string {
  const all = count === 1 ? "the 1" : `all ${formatCount(count)}`;
  if (choice === "adopt") return count === 1 ? "Keep the 1 change" : `Keep all ${formatCount(count)} changes`;
  if (choice === "reassert") return `Put ${all} back`;
  return `Leave ${all} for now`;
}

export interface BulkTarget {
  campaign: { id: string; name: string; status: string };
  /** Prices the filters match: what the decision covers. */
  count: number;
  /** All the prices waiting for this campaign, filters or not. */
  waiting: number;
  /** The product and direction filters in words, or null. */
  filters: string | null;
}

/**
 * The decisions, under the count they act on. Or, when the matching prices belong to more
 * than one campaign, what to do first: a hold is per campaign and so is a put-back's run.
 */
export function DriftBulkActions({
  target,
  campaigns,
  busy,
}: {
  target: BulkTarget | null;
  /** How many campaigns the matching prices belong to. */
  campaigns: number;
  busy: boolean;
}) {
  if (!target) {
    return campaigns > 1 ? (
      <Secondary>
        These prices belong to {formatCount(campaigns)} campaigns. Choose one under Campaign to decide all of its
        drifted prices at once.
      </Secondary>
    ) : null;
  }

  return (
    <s-stack gap={SPACE.tight}>
      <Caption>
        All {prices(target.count)} {target.filters ? "matching" : "waiting"} for &ldquo;{target.campaign.name}&rdquo;, at once
      </Caption>
      <ActionRow>
        {BULK_CHOICES.map((choice) => (
          <s-button
            key={choice.value}
            type="button"
            tone={choice.tone}
            loading={busy || undefined}
            commandFor={MODAL[choice.value]}
            command="--show"
          >
            {bulkLabel(choice.value, target.count)}
          </s-button>
        ))}
      </ActionRow>
    </s-stack>
  );
}

/** What each decision does, said where it is confirmed. */
const CONSEQUENCE: Record<DriftChoice, (campaign: string) => string> = {
  adopt: () =>
    "Each edited price becomes its variant's new baseline, so every future campaign computes from it. Nothing puts " +
    "the old baselines back in one step. An edit the storefront no longer shows is left in the queue.",
  reassert: (campaign) =>
    `Anchor writes ${campaign}'s price again over each of these edits, in one run, and reads every one back. ` +
    "A price Shopify does not confirm stays in the queue.",
  ignore: () =>
    "The alerts close and nothing else changes: the edited prices stay on the storefront, and the baselines stay as they are.",
};

/**
 * The three dialogs. Outside the card, as the cost page's is: a dialog is not one of the
 * card's actions, and its primary button is the dialog's.
 */
export function DriftBulkConfirmations({
  target,
  busy,
  onConfirm,
}: {
  target: BulkTarget;
  busy: boolean;
  onConfirm: (choice: DriftChoice) => void;
}) {
  const name = `"${target.campaign.name}"`;
  return (
    <>
      {BULK_CHOICES.map((choice) => (
        <s-modal key={choice.value} id={MODAL[choice.value]} heading={`${bulkLabel(choice.value, target.count)}?`}>
          <s-stack gap={SPACE.section}>
            <s-grid gridTemplateColumns="auto 1fr" gap={SPACE.item}>
              <Caption>Campaign</Caption>
              <s-text>{target.campaign.name}</s-text>
              <Caption>Drifted prices</Caption>
              <s-text>
                {formatCount(target.count)} of the {formatCount(target.waiting)} waiting for it
              </s-text>
              {target.filters ? (
                <>
                  <Caption>Matching</Caption>
                  <s-text>{target.filters}</s-text>
                </>
              ) : null}
            </s-grid>
            <Secondary>{CONSEQUENCE[choice.value](name)}</Secondary>
            <Secondary>
              Recorded in the Activity log as one entry, with every variant it covers. An edit made after this page
              loaded is not included.
            </Secondary>
          </s-stack>

          <s-button slot="secondary-actions" commandFor={MODAL[choice.value]} command="--hide">
            Cancel
          </s-button>
          {/* Primary, as a dialog's confirm is (#609); critical where it changes something. */}
          <s-button
            slot="primary-action"
            variant="primary"
            tone={choice.value === "ignore" ? "auto" : "critical"}
            loading={busy || undefined}
            commandFor={MODAL[choice.value]}
            command="--hide"
            onClick={() => onConfirm(choice.value)}
          >
            {bulkLabel(choice.value, target.count)}
          </s-button>
        </s-modal>
      ))}
    </>
  );
}

/** How often the page asks while the worker has a decision. Each step is a few statements. */
export const FOLLOW_MS = 3_000;

/** Reloads the page's data while a decision runs in the background, and stops when it ends. */
export function useFollowBatch(running: boolean): void {
  const revalidator = useRevalidator();
  // The latest revalidator, read by the timer: depending on the object itself would
  // restart the interval on every render, which every answer causes.
  const latest = useRef(revalidator);
  useEffect(() => {
    latest.current = revalidator;
  });

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (latest.current.state === "idle") void latest.current.revalidate();
    }, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [running]);
}
