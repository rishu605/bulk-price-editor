/**
 * The one-page result a campaign ends with.
 *
 * Separate from the preview's margin panel even though both describe margin, because they
 * answer different questions: the preview says what a campaign will do, this says what it
 * did. Showing them in the same shape would invite a merchant to read one as confirming
 * the other, and a partial run is exactly where they disagree.
 */

import { formatCount } from "../lib/format/display";
import type { CampaignResult } from "../services/campaigns/result.server";

export function RunResultSection({ result }: { result: CampaignResult }) {
  const { counts, margin } = result;

  return (
    <s-section heading="What this run did">
      {/* The headline states the outcome before any number, and leads with what went
          wrong. A partial run that opens with its successes is the failure this whole
          product exists to prevent. */}
      <s-banner tone={result.clean ? "success" : counts.failed > 0 ? "critical" : "warning"}>
        <s-paragraph>{result.summary}</s-paragraph>
      </s-banner>

      <s-stack direction="inline" gap="base">
        <Count label="Verified" value={counts.verified} />
        {counts.clamped > 0 ? <Count label="Clamped by a guardrail" value={counts.clamped} /> : null}
        {counts.skipped > 0 ? <Count label="Needed no change" value={counts.skipped} /> : null}
        {counts.reverted > 0 ? <Count label="Reverted since" value={counts.reverted} /> : null}
        {counts.unverified > 0 ? <Count label="Not read back" value={counts.unverified} /> : null}
        {counts.failed > 0 ? <Count label="Failed" value={counts.failed} /> : null}
        {counts.pending > 0 ? <Count label="Still to run" value={counts.pending} /> : null}
      </s-stack>

      {margin.covered > 0 ? (
        <>
          <s-paragraph>
            <s-text>
              Average margin went from {margin.averageBefore.toFixed(1)}% to{" "}
              {margin.averageAfter.toFixed(1)}%
              {margin.unknown > 0
                ? `, across the ${margin.covered} products that have a cost recorded. ${margin.unknown} do not, and are not included.`
                : `, across all ${margin.covered} products.`}
            </s-text>
          </s-paragraph>

          {margin.belowCost.length > 0 ? (
            <s-banner tone="critical">
              <s-paragraph>
                {margin.belowCost.length} of these are now selling at or below cost:
              </s-paragraph>
              <s-unordered-list>
                {margin.belowCost.map((row) => (
                  <s-list-item key={row.variantGid}>
                    {row.title} — {row.after.toFixed(1)}% margin
                  </s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          ) : null}

          {margin.belowTarget.length > 0 ? (
            <s-banner tone="warning">
              <s-paragraph>
                {margin.belowTarget.length} are below your target margin, worst first:
              </s-paragraph>
              <s-unordered-list>
                {margin.belowTarget.map((row) => (
                  <s-list-item key={row.variantGid}>
                    {row.title} — {row.before.toFixed(1)}% became {row.after.toFixed(1)}%
                  </s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          ) : null}
        </>
      ) : (
        <s-paragraph>
          <s-text>
            No margin figures: none of the products this run changed has a cost recorded.
            Import your costs and this fills in for the next run.
          </s-text>
        </s-paragraph>
      )}

      {/* A cap that stays quiet reads as "we measured the whole campaign". */}
      {result.marginCoveredRows !== null ? (
        <s-paragraph>
          <s-text tone="caution">
            The margin figures above cover the first {formatCount(result.marginCoveredRows)}{" "}
            of {formatCount(counts.total)} rows. The counts cover all of them.
          </s-text>
        </s-paragraph>
      ) : null}

      <s-paragraph>
        <s-text tone="neutral">{result.unavailable}</s-text>
      </s-paragraph>
    </s-section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <s-stack gap="none">
      <s-text type="strong">{formatCount(value)}</s-text>
      <s-text tone="neutral">{label}</s-text>
    </s-stack>
  );
}
