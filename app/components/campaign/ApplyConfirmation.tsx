import { describeRunDuration } from "../../lib/planning/duration";
import { formatCount } from "../../lib/format/display";
import { SPACE } from "../../lib/ui/spacing";
import type { CampaignPreview } from "../../services/campaigns/types";

/**
 * What is about to happen, in sentences, before anything is written.
 *
 * The apply button used to submit straight from the header. Our two-step shape — create a
 * draft, then apply it — was already safer than every competitor: RUBIX has no
 * confirmation and no submit button in its form at all, and Sami will change every price
 * in a catalogue on one click of Save. What we did not have was the sentence.
 *
 * NA's modal is the thing to beat and it does three things worth taking. It **restates**
 * the job in plain English rather than re-rendering the form. It gives a **duration**
 * sized to the job. And it asks for an **acknowledgement only when one is earned** — the
 * checkbox appears because discount blocking is on, and its label says so.
 *
 * The third is the one that matters. A confirmation that always asks is a confirmation
 * nobody reads, and this page already had that failure in a milder form: `blastRadius`
 * has existed since the preview was written and produced a warning banner inside the
 * Preview *tab*, which a merchant pressing Apply from the header has no reason to have
 * opened. A-3.11 asked for typed confirmation over a thousand variants and it was never
 * built. It is here.
 */
/**
 * The modal's id, and the handle the header's button opens it by.
 *
 * A literal, not a prop. `commandFor` is typed `Lowercase<string>` because HTML ids match
 * case-sensitively, and a `string` will not satisfy it — which is the type system saying
 * something true: an id assembled at runtime is a button that silently opens nothing.
 * There is one of these modals on the page, so it gets one name.
 */
export const APPLY_MODAL_ID = "apply-confirmation" as const;

export function ApplyConfirmation({
  preview,
  scheduleText,
  children,
}: {
  preview: CampaignPreview;
  /** The schedule sentence the header shows, restated here where the decision is made. */
  scheduleText?: string | null;
  /**
   * The submit control, which must carry `slot="primary-action"` itself.
   *
   * Passed in rather than built here so this component owns no fetcher and no intent —
   * the header already has both, and a modal that submits on its own behalf is a second
   * place the apply can be triggered from.
   */
  children: React.ReactNode;
}) {
  const { counts, markets, blastRadius, writePath } = preview;

  return (
    <s-modal id={APPLY_MODAL_ID} heading={`Apply ${preview.name}?`}>
      <s-stack gap={SPACE.section}>
        {/* A restatement, not a re-render of the form. Each line is a fact about this
            run; lines that do not apply are absent rather than empty, because a row
            reading "Markets: none" is a thing to read and dismiss on every apply. */}
        <s-stack gap={SPACE.item}>
          <Fact label="Prices to write">
            {formatCount(counts.planned)} of{" "}
            {formatCount(counts.planned + counts.noop + counts.skipped)} variants in scope
          </Fact>

          {counts.noop > 0 ? (
            <Fact label="Already correct">
              {formatCount(counts.noop)} — no write needed, still owned by this campaign
            </Fact>
          ) : null}

          {counts.skipped > 0 ? (
            <Fact label="Left alone">{formatCount(counts.skipped)}, with reasons on the Preview tab</Fact>
          ) : null}

          {/* Clamped rows are the one count that changes a price to something the rule
              did not ask for, so it is never folded into "planned" here. */}
          {counts.clamped > 0 ? (
            <Fact label="Raised to a floor">
              {formatCount(counts.clamped)} would price below a guardrail and will be
              written at the floor instead
            </Fact>
          ) : null}

          {markets.length > 0 ? (
            <Fact label="Also priced in">
              {markets.map((market) => market.name).join(", ")}
            </Fact>
          ) : null}

          {scheduleText ? <Fact label="Schedule">{scheduleText}</Fact> : null}

          <Fact label="How long">
            {describeRunDuration(writePath === "bulk" ? "bulk" : "sync", counts.planned)}
          </Fact>

          {/* NA's modal says who gets emailed when the job completes. We have no
              per-shop notification address to name — the alerting in
              `lib/observability` is operator-facing, not merchant-facing — so this says
              nothing rather than promising a message that will not arrive. #475. */}
        </s-stack>

        {/* The one thing this app can say that none of the three competitors can. It is
            here rather than only in the help centre because this is the moment a merchant
            is deciding whether it is safe to press the button. */}
        <s-paragraph>
          <s-text color="subdued">
            Every price is computed from its baseline, so applying twice gives the same
            result. Reverting recomputes without this campaign rather than restoring a
            saved number.
          </s-text>
        </s-paragraph>

        {blastRadius ? (
          <s-banner tone="warning">
            <s-paragraph>
              This campaign writes more than 1,000 prices. Type <s-text type="strong">apply</s-text>{" "}
              to confirm you have read the preview.
            </s-paragraph>
            <s-text-field
              name="confirmation"
              label="Type apply to confirm"
              required
              details="Only campaigns over a thousand variants ask for this."
            />
          </s-banner>
        ) : null}
      </s-stack>

      {/* Kebab-case, and the type system is what says so: `slot` is typed
          `Lowercase<string>`, and the React binding for `s-modal` omits `primaryAction`
          and `secondaryActions` as props precisely because they are slots. A camelCase
          slot name compiles nowhere and would have rendered a modal with no buttons. */}
      <s-button slot="secondary-actions" commandFor={APPLY_MODAL_ID} command="--hide">
        Cancel
      </s-button>

      {/* The submit itself, passed in with its own `slot="primary-action"`, so this
          component owns no fetcher and no intent. */}
      {children}
    </s-modal>
  );
}

/** A label and its value on one row, so the modal reads as a list of facts. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <s-stack direction="inline" gap={SPACE.item}>
      <s-text type="strong">{label}</s-text>
      <s-text>{children}</s-text>
    </s-stack>
  );
}
