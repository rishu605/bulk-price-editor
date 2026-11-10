import { countOf, formatCount } from "../../lib/format/display";
import { SPACE } from "../../lib/ui/spacing";
import { Secondary } from "../Type";

/**
 * How many variants the scope matches, under the builder that sets it (#817, PRD A-2.1's "live
 * debounced match count + 10-row sample").
 *
 * Counted by `astToWhere`, the one compilation planning uses, wherever the number comes from:
 * the editor's preview, which prices the same scope, or the Segments form's own count. The last
 * answer stays on screen while a new one is worked out, marked as updating, as the preview's do.
 */
export function MatchCount({
  matched,
  pending,
  problem,
  sample = [],
  sampleTotal,
}: {
  /** Null before the first answer. */
  matched: number | null;
  pending: boolean;
  /** Why the scope cannot be counted: a stock that is not a whole number, too many picked. */
  problem?: string | null;
  /** A few of the variants it matches, by name. */
  sample?: readonly string[];
  /** How many the sample is drawn from, when it is not all of them. */
  sampleTotal?: number;
}) {
  if (problem) {
    return (
      <s-paragraph>
        <s-text tone="critical">{problem}</s-text>
      </s-paragraph>
    );
  }
  if (matched === null) return <Secondary>{pending ? "Counting the variants this matches…" : "Change a condition to count what it matches."}</Secondary>;

  return (
    <s-stack gap={SPACE.tight}>
      <s-paragraph>
        <s-text type="strong">Matches {countOf(matched, "variant")}.</s-text>
        {pending ? <s-text color="subdued"> · updating…</s-text> : null}
      </s-paragraph>
      {sample.length > 0 ? (
        <Secondary>
          {sample.join(", ")}
          {(sampleTotal ?? matched) > sample.length ? `, and ${formatCount((sampleTotal ?? matched) - sample.length)} more.` : "."}
        </Secondary>
      ) : null}
    </s-stack>
  );
}
