/**
 * What this campaign would do: counts, write path, approval, margins, markets and the
 * per-row preview.
 *
 * The largest of the tab bodies by a wide margin, which is most of why the page was 690
 * lines and every other section was below the fold.
 */

import { CountsRow } from "../../components/CountsRow";
import { PreviewTable } from "../../components/PreviewTable";
import { downloadCsv, filenameSlug } from "../../lib/reporting/csv";
import { previewCsv } from "../../lib/reporting/preview-csv";
import type { CampaignDetailProps } from "./props";

export function CampaignPreviewTab({ preview, approval, fetcher, busy }: CampaignDetailProps) {
  return (
    <>
      <s-section heading="Preview">
        <CountsRow
          items={[
            { label: "Will change", value: preview.counts.planned },
            { label: "Already correct", value: preview.counts.noop },
            { label: "Skipped", value: preview.counts.skipped },
            { label: "Clamped", value: preview.counts.clamped },
          ]}
        />

        <s-paragraph>
          <s-text>
            Write path: {preview.writePath} — {preview.writePathReason}
          </s-text>
        </s-paragraph>

        {approval.required ? (
          <s-section heading="Approval">
            <s-paragraph>
              <s-text>
                {approval.state === "approved"
                  ? `Approved by ${approval.who}.`
                  : approval.state === "declined"
                    ? `Declined by ${approval.who}${approval.note ? `: ${approval.note}` : "."}`
                    : approval.state === "pending"
                      ? `${approval.who} asked for approval. Somebody else has to sign it off — including you, if you were not the one who asked.`
                      : "This campaign changes enough products to need a second person's approval before it can run."}
              </s-text>
            </s-paragraph>

            <s-stack direction="inline" gap="base">
              {approval.state === "none" || approval.state === "declined" ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="request-approval" />
                  <s-button type="submit" loading={busy || undefined}>
                    Ask for approval
                  </s-button>
                </fetcher.Form>
              ) : null}

              {approval.state === "pending" ? (
                <>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="approve" />
                    <s-button type="submit" variant="primary" loading={busy || undefined}>
                      Approve
                    </s-button>
                  </fetcher.Form>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="decline" />
                    <s-button type="submit" tone="critical" loading={busy || undefined}>
                      Decline
                    </s-button>
                  </fetcher.Form>
                </>
              ) : null}
            </s-stack>
          </s-section>
        ) : null}

        {preview.margin ? (
          <s-section heading="What this does to your margins">
            <s-paragraph>
              <s-text>{preview.margin.summary}</s-text>
            </s-paragraph>
            <s-paragraph>
              {/* Said plainly, because overstating causality in a pricing tool is how
                  merchants make expensive decisions on bad inference. */}
              <s-text tone="neutral">
                This is arithmetic on your prices and costs. It does not predict what you
                will sell.
              </s-text>
            </s-paragraph>

            {preview.margin.belowCost.length > 0 ? (
              <s-banner tone="critical">
                <s-paragraph>
                  {preview.margin.belowCost.length} of these would sell at or below cost:
                </s-paragraph>
                <s-unordered-list>
                  {preview.margin.belowCost.map((row) => (
                    <s-list-item key={row.variantGid}>
                      {row.title} — {row.after.toFixed(1)}% margin
                    </s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            ) : null}

            {preview.margin.belowTarget.length > 0 ? (
              <s-banner tone="warning">
                <s-paragraph>
                  {preview.margin.belowTarget.length} would fall below your target margin,
                  worst first:
                </s-paragraph>
                <s-unordered-list>
                  {preview.margin.belowTarget.map((row) => (
                    <s-list-item key={row.variantGid}>
                      {row.title} — {row.before.toFixed(1)}% becomes {row.after.toFixed(1)}%
                    </s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            ) : null}
          </s-section>
        ) : null}

        {preview.markets.length > 0 ? (
          <s-section heading="Markets">
            <s-paragraph>
              <s-text>
                Each market is priced from its own normal price in its own currency,
                not converted from the base sale price.
              </s-text>
            </s-paragraph>

            {preview.markets.map((market) => (
              <s-paragraph key={market.priceListGid}>
                <s-text>{market.explanation}</s-text>
                {market.clamped > 0 || market.skipped > 0 ? (
                  <s-text tone="caution">
                    {" "}
                    A guardrail affects {market.clamped + market.skipped} of them here
                    {market.clamped > 0 ? ` (${market.clamped} raised to the floor)` : ""}
                    {market.skipped > 0 ? ` (${market.skipped} left alone)` : ""}.
                  </s-text>
                ) : null}
              </s-paragraph>
            ))}
          </s-section>
        ) : null}

        {preview.blastRadius ? (
          <s-banner tone="warning">
            <s-paragraph>
              This campaign changes more than 1,000 variants. Re-read the preview
              before applying.
            </s-paragraph>
          </s-banner>
        ) : null}

        <PreviewTable rows={preview.rows} markets={preview.markets} />

        <s-button
          type="button"
          variant="tertiary"
          onClick={() =>
            downloadCsv(
              `preview-${filenameSlug(preview.name) || "campaign"}.csv`,
              previewCsv(preview.rows, preview.markets),
            )
          }
        >
          Export this preview (CSV)
        </s-button>
      </s-section>
    </>
  );
}
