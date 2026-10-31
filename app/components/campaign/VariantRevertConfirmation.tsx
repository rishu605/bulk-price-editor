import { SPACE } from "../../lib/ui/spacing";
import { Secondary } from "../Type";

/**
 * The modal's id, and the handle every ledger row's button opens it by.
 *
 * A literal, for the reason `ApplyConfirmation` gives: `commandFor` is typed
 * `Lowercase<string>` because HTML ids match case-sensitively, and an id assembled at
 * runtime is a button that silently opens nothing. One modal for the whole table, told
 * which row it is about, rather than a modal per row.
 */
export const VARIANT_REVERT_MODAL_ID = "variant-revert-confirmation";

/** The row a merchant pressed, and what the page already knows about it. */
export interface VariantRevertTarget {
  variantGid: string;
  title: string;
  /**
   * The base price it goes to, from the rollback report: `resolve(without this campaign)`
   * by the same planner the run uses, so the dialog cannot name a price the run will not
   * write. Null where the report has no row for it -- deleted, already let go of, or a
   * campaign that prices markets only.
   */
  revertsTo: string | null;
  /** Already taken out of this campaign by an earlier press, so this one only rewrites. */
  excluded: boolean;
}

/**
 * What "Revert this variant" does, before it does it (#764).
 *
 * The button posted straight through: one click wrote a live price and took the variant
 * out of the campaign for good, with nothing in between -- the only price write in the app
 * that did not confirm. Apply, Revert and Resume all ask first.
 *
 * Three things the merchant needs at the moment of deciding, and the order is the order
 * they are most likely to have wrong: which variant, the price it goes to -- recomputed,
 * not restored, so it can land on another sale's price rather than the full one -- and
 * that leaving is permanent. The last is the one nothing else on the page would ever tell
 * them: every later run skips the variant, and none of them says so.
 */
export function VariantRevertConfirmation({
  campaignName,
  target,
  marketNames,
  busy,
  onConfirm,
}: {
  campaignName: string;
  /** Null until a row's button is pressed. */
  target: VariantRevertTarget | null;
  /** The markets this campaign prices, whose prices for the variant are recomputed too. */
  marketNames: string[];
  busy?: boolean;
  /** Commit. A callback rather than a form: see `RevertConfirmation`, and #609. */
  onConfirm: () => void;
}) {
  const title = target?.title ?? "this variant";

  return (
    <s-modal id={VARIANT_REVERT_MODAL_ID} heading={`Revert ${title}?`}>
      <s-stack gap={SPACE.section}>
        <s-paragraph>
          {target?.revertsTo ? (
            <s-text>
              Its price goes to <s-text type="strong">{target.revertsTo}</s-text>: what it
              would be without {campaignName}, worked out again rather than put back from
              before the campaign.
            </s-text>
          ) : (
            <s-text>
              Its price is worked out again without {campaignName} and written: what it
              would be if the campaign did not cover it, rather than a saved price put back.
            </s-text>
          )}
        </s-paragraph>

        {marketNames.length > 0 ? (
          <Secondary>
            Its prices in {listOf(marketNames)} are worked out the same way.
          </Secondary>
        ) : null}

        {target?.excluded ? (
          <s-paragraph>
            <s-text>
              It is already out of {campaignName}, so nothing else changes: this only writes
              its price again. Use it when the last revert of this variant did not finish.
            </s-text>
          </s-paragraph>
        ) : (
          <s-paragraph>
            <s-text tone="caution">
              It leaves {campaignName} for good. Every later run — scheduled, or
              applying the campaign again — leaves this variant at that price.
            </s-text>
          </s-paragraph>
        )}
      </s-stack>

      <s-button slot="secondary-actions" commandFor={VARIANT_REVERT_MODAL_ID} command="--hide">
        Cancel
      </s-button>

      {/* `variant="primary"` with `tone="critical"`, as in `RevertConfirmation`: Polaris
          only draws a primary button in this slot, and the tone carries the rest. */}
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        loading={busy || undefined}
        disabled={!target || undefined}
        commandFor={VARIANT_REVERT_MODAL_ID}
        command="--hide"
        onClick={onConfirm}
      >
        Revert this variant
      </s-button>
    </s-modal>
  );
}

/** "Europe", "Europe and Japan", "Europe, Japan and Wholesale". */
function listOf(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
