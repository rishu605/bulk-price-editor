import { DRAFT_DEFAULTS } from "../lib/campaigns/draft-defaults";

/**
 * The rule kind that has no amount, because the file carries every price.
 *
 * Named rather than written out at each of the four places that branch on it: the string
 * is load-bearing — it decides whether a scope section renders — and a typo would produce
 * a page that silently keeps the wrong half.
 */
export const FROM_FILE = "from-file";

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
  kind,
  onKindChange,
  name = "ruleValue",
  selectName = "ruleKind",
}: {
  currency: string;
  /**
   * Which rule is chosen, held by the route rather than here.
   *
   * It used to be local state, which was right while every option was an arithmetic on
   * the baseline. `from-import` is not: choosing it removes the scope section and swaps
   * the whole rule for a file, and a page cannot react to a choice a component is keeping
   * to itself.
   */
  kind: string;
  onKindChange: (kind: string) => void;
  name?: string;
  selectName?: string;
}) {
  const money = kind === "fixed-change" || kind === "set-exact";

  return (
    <>
      <s-select
        name={selectName}
        label="How should prices change?"
        onChange={(event) => onKindChange(String(event.currentTarget.value))}
      >
        <s-option value={DRAFT_DEFAULTS.ruleKind} defaultSelected>
          Percent change from baseline
        </s-option>
        <s-option value="fixed-change">Fixed change from baseline</s-option>
        <s-option value="set-exact">Set an exact price</s-option>
        {/* A file is a way prices change, not a different door.
            
            #416 dissolved the Imports nav item on the rule that a nav item is a noun; the
            page survived as a button on the campaigns index, which is the same mistake
            one size smaller — two merchants wanting the same object, sent through two
            doors. A spreadsheet is an answer to "how should prices change", so it is an
            option here. */}
        <s-option value={FROM_FILE}>From a spreadsheet</s-option>
      </s-select>

      {kind === FROM_FILE ? null : money ? (
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
