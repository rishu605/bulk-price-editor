import { useRef, type ElementRef } from "react";

import { describeRunDuration } from "../../lib/planning/duration";
import { formatCount } from "../../lib/format/display";
import { SPACE } from "../../lib/ui/spacing";
import type { CampaignPreview } from "../../services/campaigns/types";
import { Secondary } from "../Type";

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
  rule,
  scope,
  notifyEmail,
  scheduleText,
  busy,
  onConfirm,
}: {
  preview: CampaignPreview;
  /** From `describeCampaign`, the same call the campaigns index makes. */
  rule: string;
  scope: string;
  /**
   * Where the outcome will be emailed, or null if notifications are off.
   *
   * From the shop's notification preferences, not from anything about this campaign —
   * the address is one per shop, and the run report goes to whoever is listed there.
   */
  notifyEmail: string | null;
  /** The schedule sentence the header shows, restated here where the decision is made. */
  scheduleText?: string | null;
  /** A request is in flight, so the submit shows it. */
  busy?: boolean;
  /**
   * Commit, carrying whatever was typed into the confirmation box.
   *
   * A callback rather than a submit control passed in as `children`, because Polaris
   * refuses to render anything else — see the note on the button below. This component
   * still owns no fetcher and no intent: the header supplies both, and the string handed
   * back is read from the field this modal owns, which is the only place it exists.
   */
  onConfirm: (confirmation: string) => void;
}) {
  const { counts, markets, blastRadius, writePath } = preview;

  // Read at click time rather than held in state. Polaris fields are uncontrolled here
  // (see `docs/polaris-notes.md` on `defaultValue`), and the value is wanted once.
  const confirmation = useRef<ElementRef<"s-text-field">>(null);

  return (
    <s-modal id={APPLY_MODAL_ID} heading={`Apply ${preview.name}?`}>
      <s-stack gap={SPACE.section}>
        {/* A restatement, not a re-render of the form. Each line is a fact about this
            run; lines that do not apply are absent rather than empty, because a row
            reading "Markets: none" is a thing to read and dismiss on every apply. */}
        <s-stack gap={SPACE.item}>
          {/* The same two sentences the campaigns index shows, through the same
              formatter. A merchant who read "20% off · In Outerwear" in the list should
              meet those words again at the moment they commit, not a second description
              of one campaign. */}
          <Fact label="Rule">{rule}</Fact>
          <Fact label="Applies to">{scope}</Fact>

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

          {/* NA's modal says who gets emailed when the job completes, and this is the
              moment a merchant decides whether to sit and watch. Both branches are worth
              rendering: naming the address is a promise kept, and saying plainly that
              nobody will be told is the thing they need *before* closing the tab on a
              run over a hundred thousand variants — not after. */}
          <Fact label="When it finishes">
            {notifyEmail ? `We will email ${notifyEmail}` : "Nobody is emailed — set an address in Settings"}
          </Fact>
        </s-stack>

        {/* The one thing this app can say that none of the three competitors can. It is
            here rather than only in the help centre because this is the moment a merchant
            is deciding whether it is safe to press the button. */}
        <Secondary>
          Every price is computed from its baseline, so applying twice gives the same
          result. Reverting recomputes without this campaign rather than restoring a
          saved number.
        </Secondary>

        {blastRadius ? (
          <s-banner tone="warning">
            <s-paragraph>
              This campaign writes more than 1,000 prices. Type <s-text type="strong">apply</s-text>{" "}
              to confirm you have read the preview.
            </s-paragraph>
            <s-text-field
              ref={confirmation}
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

      {/* A button, directly, with `variant="primary"` — not a form wrapping one.

          This is the whole of #609, and `polaris.js` says it in as many words:

              "Only Button elements with a `variant` of `primary` are allowed in the
               `primary-action` slot."

          The slot is matched against the element carrying it, so the `fetcher.Form` that
          used to be here was dropped and the dialog rendered Cancel and nothing else —
          a campaign could not be applied from the UI at all. The warning Polaris emits
          goes to the app's own console, which lives in a cross-origin iframe, so nothing
          said so. `PageShell` records the same rule for `s-page`, and `CampaignHeader`
          records it for `s-menu`; this is the third place it has bitten.

          Which also fixes the typed confirmation: the field sits in the modal body, so
          it was never inside that form and its value was never posted. Over a thousand
          variants the server refused every apply, whatever the merchant typed. */}
      <s-button
        slot="primary-action"
        variant="primary"
        loading={busy || undefined}
        commandFor={APPLY_MODAL_ID}
        command="--hide"
        onClick={() => onConfirm(String(confirmation.current?.value ?? ""))}
      >
        Apply now
      </s-button>
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
