import { formatCount } from "../../lib/format/display";
import { costCount } from "../../lib/pricing/cost-form";
import { SPACE } from "../../lib/ui/spacing";
import { Caption, Secondary } from "../Type";

/**
 * The modal's id, and the handle the form's button opens it by.
 *
 * A literal, for the reason `ApplyConfirmation` gives: `commandFor` is typed
 * `Lowercase<string>` because HTML ids match case-sensitively, and an id assembled at
 * runtime is a button that silently opens nothing.
 */
export const COST_CHANGE_MODAL_ID = "cost-change-confirmation";

/** What the last check found, as the action returned it. */
export interface CostCheck {
  /** `checkKeyOf` the rule and scope that were counted. Posted back with the commit. */
  key: string;
  changed: number;
  matched: number;
  /** Variants the rule could not compute a cost for. */
  skipped: number;
  /** `describeCostRule`, the sentence the check's banner opened with. */
  rule: string;
  /** `costScopeOf` the vendor. */
  scope: string;
}

/**
 * The last screen before costs change across a store (#754).
 *
 * The button used to commit straight from the form, so a merchant who opened the page and
 * pressed the second button raised every cost in the store by a 4% they never typed. This
 * is the shape the campaign Apply and Revert dialogs already have: a restatement of the
 * check in sentences, the count in the heading, and nothing written until the button that
 * names the count is pressed.
 *
 * It restates the check rather than the form. The form can be edited while this is
 * closed, and the page only enables the button that opens it while the form still matches
 * the check — so what is read here is what was counted, and the action refuses a commit
 * whose form has moved since.
 */
export function CostChangeConfirmation({
  check,
  busy,
  onConfirm,
}: {
  check: CostCheck;
  busy?: boolean;
  /** Commit. A callback rather than a passed-in control — see the button below. */
  onConfirm: () => void;
}) {
  const left = check.matched - check.changed;

  return (
    <s-modal id={COST_CHANGE_MODAL_ID} heading={`Change ${costCount(check.changed)}?`}>
      <s-stack gap={SPACE.section}>
        {/* One grid for every line, as `ApplyConfirmation` does and for its reason: a
            stack of inline pairs starts each value wherever its own label ended. */}
        <s-grid gridTemplateColumns="auto 1fr" gap={SPACE.item}>
          <Fact label="Rule">{check.rule}</Fact>
          <Fact label="Applies to">{check.scope}</Fact>
          <Fact label="Costs to change">
            {formatCount(check.changed)} of {formatCount(check.matched)} variants
          </Fact>
          {left > 0 ? (
            <Fact label="Left as they are">
              {formatCount(left)}
              {check.skipped > 0
                ? ` — ${formatCount(check.skipped)} of them the rule could not work out a cost for, with reasons under the form`
                : " — already at that cost"}
            </Fact>
          ) : null}
        </s-grid>

        {/* Why this is worth a dialog, said where the decision is made. A cost is not a
            price, so "nothing on your storefront changes" is true and is exactly what
            makes the change easy to underestimate. */}
        <Secondary>
          Costs set your never-below-cost and minimum-margin floors, so this moves the
          floor under every campaign on these variants. Nothing on your storefront changes
          now. Each old cost stays in its baseline&rsquo;s history, but nothing puts them
          all back in one step.
        </Secondary>
      </s-stack>

      <s-button slot="secondary-actions" commandFor={COST_CHANGE_MODAL_ID} command="--hide">
        Cancel
      </s-button>

      {/* `variant="primary"` with `tone="critical"`, as Revert's is: Polaris draws only a
          primary button in the `primary-action` slot (#609), and the tone is what says
          this one writes. */}
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        loading={busy || undefined}
        commandFor={COST_CHANGE_MODAL_ID}
        command="--hide"
        onClick={onConfirm}
      >
        Change {costCount(check.changed)}
      </s-button>
    </s-modal>
  );
}

/** One line of the restatement: two cells of the grid above, as `ApplyConfirmation`'s. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <Caption>{label}</Caption>
      <s-text>{children}</s-text>
    </>
  );
}
