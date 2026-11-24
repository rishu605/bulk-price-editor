import { BREACH_POLICY_LABELS } from "../../lib/campaigns/breach-policy";
import { FLOOR_FIELDS, LOOSEN_WORD, type FloorFields } from "../../lib/campaigns/campaign-floors";
import type { GuardrailViolationPolicy } from "../../lib/pricing/types";
import { SPACE } from "../../lib/ui/spacing";
import { FieldGrid, FullRow } from "../FieldGrid";
import { Secondary } from "../Type";

/**
 * A campaign's own floors and floor-breach policy, as fields (#816, PRD A-3.7, D30): in the
 * editor's Advanced section, and on the campaign's Overview tab once it exists.
 *
 * Each field starts at what applies -- in the editor, the store's floors from Settings -- so a
 * merchant who touches none of them saves a campaign that sets nothing and follows the store,
 * exactly as every campaign did before this. Raising one tightens it for this campaign. Lowering
 * one is asked for by name: the save answers with the sentence and the box for the word, and the
 * audit log records who typed it.
 *
 * The policy offers the store's setting first, named, rather than copying it silently: chosen
 * here, it is the campaign's whatever Settings says, and a campaign that has started keeps the
 * policy it started with, so the select is not offered then.
 */
export function CampaignFloorsFields({
  currency,
  initial,
  storeFloors,
  storePolicy,
  policyKept,
  ask,
}: {
  /** The store's currency, which the minimum price is typed in. */
  currency: string;
  /** What the fields show: the floors that apply, and the campaign's own policy or "". */
  initial: FloorFields;
  /** The store's floors in a sentence, which the fields start from in the editor. */
  storeFloors: string;
  /** Settings' policy, which a campaign without its own follows until it starts. */
  storePolicy: GuardrailViolationPolicy;
  /**
   * The policy a started campaign keeps until it ends, said instead of offered (D21). Absent
   * while it can still be chosen.
   */
  policyKept?: string;
  /** The save's question, when what was typed goes below the store's floors: the box goes with it. */
  ask?: string | null;
}) {
  return (
    <s-stack gap={SPACE.item}>
      {/* Says the rest were posted, so a box left unticked reads as unticked, not as missing. */}
      <input type="hidden" name={FLOOR_FIELDS.marker} value="1" />
      <Secondary>
        The store&rsquo;s floors, from Settings: {storeFloors}. Raise one to tighten it for this
        campaign. Setting one lower asks you to type {LOOSEN_WORD}, and is recorded in the activity log.
      </Secondary>

      <FieldGrid>
        <FullRow>
          <s-checkbox
            name={FLOOR_FIELDS.neverBelowCost}
            value="1"
            label="Never price at or below cost"
            checked={initial.neverBelowCost || undefined}
          />
        </FullRow>
        <s-number-field
          name={FLOOR_FIELDS.minMarginPercent}
          label="Minimum margin (%)"
          value={initial.minMarginPercent}
          details="Share of the selling price. Leave blank for none."
        />
        {/* A money field, as in Settings: a price in the store's currency, decimals and all. */}
        <s-money-field
          name={FLOOR_FIELDS.minPrice}
          label={`Minimum price (${currency})`}
          value={initial.minPrice}
          details="Leave blank for none. Not applied to a market priced in another currency."
        />
        {policyKept ? (
          <FullRow>
            <Secondary>When a price would breach a floor: {policyKept}</Secondary>
          </FullRow>
        ) : (
          <FullRow>
            <s-select
              name={FLOOR_FIELDS.policy}
              label="When a price would breach a floor"
              details="Chosen here, it is this campaign's whatever Settings says. Left as the store's, it follows Settings until the campaign starts."
            >
              <s-option value="" defaultSelected={initial.policy === ""}>
                {`The store's setting: ${BREACH_POLICY_LABELS[storePolicy].toLowerCase()}`}
              </s-option>
              {(["clamp", "skip", "block"] as const).map((policy) => (
                <s-option key={policy} value={policy} defaultSelected={initial.policy === policy}>
                  {BREACH_POLICY_LABELS[policy]}
                </s-option>
              ))}
            </s-select>
          </FullRow>
        )}
      </FieldGrid>

      {/* The save's own sentence, beside the box it asks for: what goes below the store's, by how much. */}
      {ask ? (
        <s-banner tone="warning">
          <s-stack gap={SPACE.item}>
            <s-paragraph>{ask}</s-paragraph>
            <s-text-field name={FLOOR_FIELDS.word} label={`Type ${LOOSEN_WORD} to confirm`} required />
          </s-stack>
        </s-banner>
      ) : null}
    </s-stack>
  );
}
