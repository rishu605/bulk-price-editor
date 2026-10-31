/**
 * The rollback report.
 *
 * Its own tab because reverting is a conversation, not a button: rows a merchant edited
 * by hand after the campaign set them are listed so they can be left alone. Burying that
 * under a page of other sections is how a merchant reverts over someone's deliberate
 * edit.
 */

import { RollbackReportTable } from "../../components/RollbackReportTable";
import { ActionRow } from "../ActionRow";
import { filenameSlug } from "../../lib/reporting/csv";
import { notBeforeSentence, rollbackSummary, unaffectedSentence } from "../../lib/reporting/rollback";
import { ExportButton } from "../ExportButton";
import type { CampaignDetailProps } from "./props";
import { Card } from "../Card";
import { countOf } from "../../lib/format/display";
import { REVERT_MODAL_ID } from "./RevertConfirmation";

export function CampaignRevertTab({ rollback, preview, fetcher, busy }: CampaignDetailProps) {
  return (
    <>
      {rollback && rollback.counts.total > 0 ? (
        <Card heading="If you revert this campaign">      <s-paragraph>
            <s-text>{rollbackSummary(rollback.counts)}</s-text>
          </s-paragraph>

          {/* A variant a higher-priority campaign took over is not an edit to decide about
              (#836), and it is not at this campaign's price either. Said, so the rows
              reading "Already there" below are not a mystery. */}
          {unaffectedSentence(rollback.counts.unaffected) ? (
            <s-paragraph>
              <s-text>{unaffectedSentence(rollback.counts.unaffected)}</s-text>
            </s-paragraph>
          ) : null}

          {/* Reverting puts back a baseline that is not the price from before this campaign,
              usually one recaptured at its own sale price (#781): said before the button. */}
          {notBeforeSentence(rollback.notBefore) ? (
            <s-banner tone="warning">
              <s-paragraph>{notBeforeSentence(rollback.notBefore)}</s-paragraph>
            </s-banner>
          ) : null}

          {/* Moved here from the actions card, which is gone. It is the one thing about
              reverting a merchant is most likely to have wrong, and it belongs beside the
              button that does it rather than beside the button that applies. */}
          <s-paragraph>
            <s-text>
              Reverting recomputes each price <s-text>without this campaign</s-text>. If
              another campaign still covers a variant, that campaign&rsquo;s price stays
              — it does not snap back to full price.
            </s-text>
          </s-paragraph>

          {rollback.counts.deleted > 0 ? (
            <s-paragraph>
              <s-text>
                {countOf(rollback.counts.deleted, "variant")}{" "}
                {rollback.counts.deleted === 1 ? "was" : "were"} deleted in Shopify.
                Nothing is written for {rollback.counts.deleted === 1 ? "it" : "them"}.
              </s-text>
            </s-paragraph>
          ) : null}

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="revert" />
            <RollbackReportTable rows={rollback.rows} total={rollback.counts.total} />
            <ActionRow>
              {/* "Keeping the ticked edits" only where there is a box to tick (#759). With
                  none, the same confirmation the header's Revert opens: a second revert
                  that skipped it would be the one unconfirmed way to end a sale. */}
              {rollback.straightforward ? (
                <s-button
                  type="button"
                  tone="critical"
                  loading={busy || undefined}
                  commandFor={REVERT_MODAL_ID}
                  command="--show"
                >
                  Revert
                </s-button>
              ) : (
                <s-button type="submit" tone="critical" loading={busy || undefined}>
                  Revert, keeping the ticked edits
                </s-button>
              )}
              {/* Every row, read on the server (#812, as #819 did for the others): the page
                  carries only the rows this tab renders, which at 102,132 variants is the
                  difference between a report and a page that does not load. */}
              <ExportButton
                href={`/app/export/rollback?campaign=${encodeURIComponent(preview.campaignId)}`}
                filename={`rollback-${filenameSlug(preview.name) || "campaign"}.csv`}
                rows={rollback.counts.total}
              />
            </ActionRow>
          </fetcher.Form>
        </Card>
      ) : null}
    </>
  );
}
