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
import { downloadCsv, filenameSlug } from "../../lib/reporting/csv";
import { rollbackReportCsv, rollbackSummary, unaffectedSentence } from "../../lib/reporting/rollback";
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
            <RollbackReportTable rows={rollback.rows} />
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
              <s-button
                type="button"
                variant="tertiary"
                icon="download"
                onClick={() =>
                  downloadCsv(
                    `rollback-${filenameSlug(preview.name) || "campaign"}.csv`,
                    rollbackReportCsv(rollback),
                  )
                }
              >
                Export this report (CSV)
              </s-button>
            </ActionRow>
          </fetcher.Form>
        </Card>
      ) : null}
    </>
  );
}
