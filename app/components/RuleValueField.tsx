import { useState } from "react";

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
  const [kind, setKind] = useState("percent-change");
  const money = kind === "fixed-change" || kind === "set-exact";

  return (
    <>
      <s-select
        name={selectName}
        label="Adjustment"
        onChange={(event) => setKind(String(event.currentTarget.value))}
      >
        <s-option value="percent-change" defaultSelected>
          Percent change from baseline
        </s-option>
        <s-option value="fixed-change">Fixed change from baseline</s-option>
        <s-option value="set-exact">Set an exact price</s-option>
      </s-select>

      {money ? (
        <s-money-field
          name={name}
          label={kind === "set-exact" ? `Price (${currency})` : `Amount (${currency})`}
          value={kind === "set-exact" ? "" : "-10"}
          details={
            kind === "set-exact"
              ? "Every variant in scope gets this exact price."
              : `Negative reduces. -10 takes ${currency} 10 off the baseline.`
          }
        />
      ) : (
        <s-number-field
          name={name}
          label="Percentage"
          value="-20"
          details="Negative discounts. -20 means 20% off the baseline."
        />
      )}
    </>
  );
}
