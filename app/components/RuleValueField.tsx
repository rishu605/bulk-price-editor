import { useState } from "react";

import { DRAFT_DEFAULTS } from "../lib/campaigns/draft-defaults";

/**
 * The rule's amount, which is a percentage or a price depending on the rule.
 *
 * One input served both, as a generic number field, so "−20" meant 20% off under one
 * rule and £20 off under another with nothing on screen to say which. The label read
 * "Value" either way.
 *
 * A money field is not cosmetic here. It knows it is entering currency: how many decimal
 * places the amount has, and what a merchant's locale uses as a separator. A generic
 * number field is where a ¥1,000 price acquires decimals it cannot have — the
 * presentational half of the bug that made every fixed-amount rule USD with a hardcoded
 * ×100 (#343).
 *
 * The label changes with the rule too, because "Value" is the word that let the two
 * meanings share a field in the first place.
 */
export function RuleValueField({
  currency,
  name = "ruleValue",
  selectName = "ruleKind",
}: {
  currency: string;
  name?: string;
  selectName?: string;
}) {
  const [kind, setKind] = useState<string>(DRAFT_DEFAULTS.ruleKind);
  const money = kind === "fixed-change" || kind === "set-exact";

  return (
    <>
      <s-select
        name={selectName}
        label="Adjustment"
        onChange={(event) => setKind(String(event.currentTarget.value))}
      >
        <s-option value={DRAFT_DEFAULTS.ruleKind} defaultSelected>
          Percent change from baseline
        </s-option>
        <s-option value="fixed-change">Fixed change from baseline</s-option>
        <s-option value="set-exact">Set an exact price</s-option>
      </s-select>

      {money ? (
        <s-money-field
          name={name}
          label={kind === "set-exact" ? `Price (${currency})` : `Amount (${currency})`}
          value={kind === "set-exact" ? "" : DRAFT_DEFAULTS.fixedValue}
          details={
            kind === "set-exact"
              ? "Every variant in scope gets this exact price."
              : `Negative reduces. ${DRAFT_DEFAULTS.fixedValue} takes ${currency} ${DRAFT_DEFAULTS.fixedValue.replace('-', '')} off the baseline.`
          }
        />
      ) : (
        <s-number-field
          name={name}
          label="Percentage"
          value={DRAFT_DEFAULTS.percentValue}
          details={`Negative discounts. ${DRAFT_DEFAULTS.percentValue} means ${DRAFT_DEFAULTS.percentValue.replace("-", "")}% off the baseline.`}
        />
      )}
    </>
  );
}
