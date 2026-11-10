import {
  COMPARE_AT_VIOLATION_LABELS,
  COMPARE_AT_VIOLATION_QUESTION,
  COMPARE_AT_VIOLATIONS,
} from "../../lib/campaigns/compare-at-violation";
import type { CompareAtViolationPolicy } from "../../lib/pricing/types";

/**
 * What a campaign does when the compare-at it would write is not above the new price (#817, PRD
 * A-3.3): drop the strike-through, leave the variant at its price, or stop the campaign.
 *
 * Every campaign dropped it, and nothing said so: a 5% sale rounded to .99 lost its
 * strike-through on the variants it reached (#825) with nothing on screen to choose otherwise.
 * Beside the compare-at select, and only while it sets one: "leave" and "clear" write no
 * compare-at the check could refuse.
 */
export function CompareAtViolationField({ initial = "clear" }: { initial?: CompareAtViolationPolicy }) {
  return (
    <s-select
      name="compareAtViolation"
      label={COMPARE_AT_VIOLATION_QUESTION}
      details="A strike-through at or under the price shows no saving, so it is never written."
    >
      {COMPARE_AT_VIOLATIONS.map((policy) => (
        <s-option key={policy} value={policy} defaultSelected={policy === initial}>
          {COMPARE_AT_VIOLATION_LABELS[policy]}
        </s-option>
      ))}
    </s-select>
  );
}
