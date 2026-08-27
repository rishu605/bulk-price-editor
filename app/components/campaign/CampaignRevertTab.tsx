/**
 * The rollback report.
 *
 * Its own tab because reverting is a conversation, not a button: rows a merchant edited
 * by hand after the campaign set them are listed so they can be left alone. Burying that
 * under a page of other sections is how a merchant reverts over someone's deliberate
 * edit.
 */

import { RollbackReportTable } from "../../components/RollbackReportTable";
import { downloadCsv, filenameSlug } from "../../lib/reporting/csv";
import { rollbackReportCsv } from "../../lib/reporting/rollback";
import type { CampaignDetailProps } from "./props";

export function CampaignRevertTab({ rollback, preview, fetcher, busy }: CampaignDetailProps) {
  return (
    <>
      {rollback && rollback.counts.total > 0 ? (
        <s-section heading="If you revert this campaign">
          <s-paragraph>
            <s-text>
              {rollback.straightforward
                ? `All ${rollback.counts.total} variants are still at the price this campaign set. Reverting recomputes each one without it.`
                : `${rollback.counts.drifted} of ${rollback.counts.total} variants have been changed since this campaign set them. Someone edited those on purpose — tick any you want left alone, then revert.`}
            </s-text>
          </s-paragraph>

          {rollback.counts.deleted > 0 ? (
            <s-paragraph>
              <s-text>
                {rollback.counts.deleted} variant
                {rollback.counts.deleted === 1 ? " was" : "s were"} deleted in Shopify.
                Nothing is written for {rollback.counts.deleted === 1 ? "it" : "them"}.
              </s-text>
            </s-paragraph>
          ) : null}

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="revert" />
            <RollbackReportTable rows={rollback.rows} />
            <s-stack direction="inline" gap="base">
              <s-button type="submit" tone="critical" loading={busy || undefined}>
                Revert, keeping the ticked edits
              </s-button>
              <s-button
                type="button"
                variant="tertiary"
                onClick={() =>
                  downloadCsv(
                    `rollback-${filenameSlug(preview.name) || "campaign"}.csv`,
                    rollbackReportCsv(rollback),
                  )
                }
              >
                Export this report (CSV)
              </s-button>
            </s-stack>
          </fetcher.Form>
        </s-section>
      ) : null}
    </>
  );
}
