import { useState } from "react";

import { DRAFT_DEFAULTS } from "../lib/campaigns/draft-defaults";
import { MAX_REDUCTION_PERCENT } from "../lib/campaigns/rule-limits";

/** The largest "Reduce by" the field steps to: just under the whole price (#818). */
const LARGEST_REDUCTION = MAX_REDUCTION_PERCENT - 0.01;

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
  initial,
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
  /** The amount and direction a link opened the editor with, for `kind` (#718, #771). */
  initial?: { direction: "down" | "up"; magnitude: string };
}) {
  const money = kind === "fixed-change" || kind === "set-exact";
  /* An exact price is not a change, so it has no direction — a sign on it would be a
     negative price. The spreadsheet path has no rule at all. */
  const directional = kind === DRAFT_DEFAULTS.ruleKind || kind === "fixed-change";
  /* Held here so the percentage can be capped while it reduces (#818). Read from the
     select's own change event, which fires for `s-select` (the kind select above relies
     on it); only a form-level `onChange` is dead under React 18 (#863). */
  const [direction, setDirection] = useState<"down" | "up">(initial?.direction === "up" ? "up" : "down");

  return (
    <>
      <s-select
        name={selectName}
        label="How should prices change?"
        onChange={(event) => onKindChange(String(event.currentTarget.value))}
      >
        {/* Selected from `kind`, not hardcoded onto the first option.
        
            Four old import URLs open this page with `?ruleKind=from-file`, and with the
            default pinned here the page did the right thing — no scope, the file section
            below — while this select went on reading "Percent change from baseline". A
            control that disagrees with the page it controls is worse than either state:
            the merchant cannot tell which one is lying. Only visible by opening the
            page. */}
        <s-option
          value={DRAFT_DEFAULTS.ruleKind}
          defaultSelected={kind === DRAFT_DEFAULTS.ruleKind}
        >
          Percent change from baseline
        </s-option>
        <s-option value="fixed-change" defaultSelected={kind === "fixed-change"}>
          Fixed change from baseline
        </s-option>
        <s-option value="set-exact" defaultSelected={kind === "set-exact"}>
          Set an exact price
        </s-option>
        {/* A file is a way prices change, not a different door.
            
            #416 dissolved the Imports nav item on the rule that a nav item is a noun; the
            page survived as a button on the campaigns index, which is the same mistake
            one size smaller — two merchants wanting the same object, sent through two
            doors. A spreadsheet is an answer to "how should prices change", so it is an
            option here. */}
        <s-option value={FROM_FILE} defaultSelected={kind === FROM_FILE}>
          From a spreadsheet
        </s-option>
      </s-select>

      {/* Which way, as a question rather than as a minus sign.

          To take 20% off, a merchant used to type `-20` into a field labelled
          "Percentage" under a line of help explaining the convention. This is the first
          control in the create flow, so that sign was the first thing the product taught
          — and typing `20`, which is what "20% off" sounds like, gave a twenty per cent
          price rise with nothing on the screen refusing it.

          A select and not two radios: it sits in a grid cell beside the amount, and the
          pair reads as one sentence — "Reduce by · 20". `draft-form.ts` takes the
          magnitude as an absolute value, so choosing "Reduce by" and typing a negative
          number still reduces rather than quietly inverting. */}
      {directional ? (
        <s-select
          name="ruleDirection"
          label="Which way"
          onChange={(event) => setDirection(event.currentTarget.value === "up" ? "up" : "down")}
        >
          <s-option value="down" defaultSelected={initial?.direction !== "up"}>
            Reduce by
          </s-option>
          <s-option value="up" defaultSelected={initial?.direction === "up"}>
            Increase by
          </s-option>
        </s-select>
      ) : null}

      {kind === FROM_FILE ? null : money ? (
        <s-money-field
          name={name}
          label={kind === "set-exact" ? `Price (${currency})` : `Amount (${currency})`}
          value={initial?.magnitude ?? (kind === "set-exact" ? "" : DRAFT_DEFAULTS.fixedMagnitude)}
          details={
            kind === "set-exact"
              ? "Every variant in scope gets this exact price."
              : "Taken off, or added to, each variant's baseline."
          }
        />
      ) : (
        /* Capped below 100 while reducing (#818): Reduce by 100, 150 or 1,000 took every
           price in scope to the smallest price, from a typo of 10 or 15. `max` stops the
           stepper there; a typed value past it is refused by name in the preview beside
           this field and by the save (`ruleInputProblem`), because Polaris lets the
           keyboard through. Increases are not capped: a 150% rise is a real rule. */
        <s-number-field
          name={name}
          label="Percentage"
          value={initial?.magnitude ?? DRAFT_DEFAULTS.percentMagnitude}
          max={direction === "down" ? LARGEST_REDUCTION : undefined}
          details={direction === "down" ? "Of each variant's baseline. Less than 100." : "Of each variant's baseline."}
        />
      )}
    </>
  );
}
