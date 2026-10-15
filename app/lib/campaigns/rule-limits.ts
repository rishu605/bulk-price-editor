/**
 * A reduction of 100% or more is not a sale, it is every price at nothing (#696, #818).
 *
 * Reduce by 100%, 150% or 1,000% of 249.99 resolves to zero or below, and the resolver
 * writes the smallest price instead: 0.01, with a strike-through from the real price. A
 * typo -- `150` for `15`, `100` for `10` -- did that to a whole scope. The editor and
 * Home's quick create refuse it as it is typed; this is the same limit for a campaign that
 * is already stored, made before those refusals existed or by a path that skipped them, so
 * that applying it is refused too, in the preview and in the run.
 */

import type { AdjustmentRule } from "../pricing/types";

/** A percentage reduction must be smaller than this. */
export const MAX_REDUCTION_PERCENT = 100;

/** Whether a signed percentage reduces by the whole price or more. */
export function reducesToNothing(percent: number): boolean {
  return percent <= -MAX_REDUCTION_PERCENT;
}

/** Why a typed reduction is refused, or null. The editor's sentence (#696). */
export function reductionProblem(percent: number): string | null {
  return reducesToNothing(percent)
    ? `A ${Math.abs(percent)}% reduction would make every price free or negative. Enter less than ${MAX_REDUCTION_PERCENT}.`
    : null;
}

/**
 * Why a stored campaign's rule cannot be applied, naming the next action, or null.
 *
 * Every rule row is checked, not only the first: a row that matched no variant in today's
 * catalogue matches one tomorrow.
 */
export function unappliableRule(ruleRows: unknown): string | null {
  const rows = Array.isArray(ruleRows) ? (ruleRows as Array<{ rule?: AdjustmentRule }>) : [];

  for (const { rule } of rows) {
    if (!rule) continue;
    if ((rule.kind === "percent-change" || rule.kind === "percent-of-compare-at") && reducesToNothing(rule.percent)) {
      return (
        `This campaign reduces prices by ${Math.abs(rule.percent)}%, which would make every price free or ` +
        `negative, so it cannot be applied. Create a campaign with a reduction under ${MAX_REDUCTION_PERCENT}% ` +
        "and archive this one."
      );
    }
  }

  return null;
}
