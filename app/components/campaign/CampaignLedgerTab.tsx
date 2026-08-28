/**
 * Every row this campaign wrote, with what it was and what we intended.
 *
 * Retained indefinitely on every plan -- it is the evidence behind every claim the rest
 * of the page makes, which is why it is a tab rather than something to scroll past.
 */

import { LedgerTable } from "../../components/LedgerTable";
import { ActionRow } from "../ActionRow";
import { downloadCsv, filenameSlug } from "../../lib/reporting/csv";
import { ledgerCsv } from "../../lib/reporting/ledger-csv";
import type { CampaignDetailProps } from "./props";

export function CampaignLedgerTab({
  preview,
  ledger,
  ledgerTotal,
  fetcher,
  busy,
}: CampaignDetailProps) {
  return (
    <>
      {ledger.length > 0 ? (
        <s-section heading="Ledger">
          <s-paragraph>
            <s-text>
              Every row we wrote, with what it was and what we intended. Retained
              indefinitely on every plan. Reverting a single variant takes it out of
              this campaign for good — including future scheduled runs — and recomputes
              its price without it.
            </s-text>
          </s-paragraph>
          <ActionRow>
            <s-button
              type="button"
              variant="tertiary"
              icon="download"
              onClick={() =>
                downloadCsv(
                  `ledger-${filenameSlug(preview.name) || "campaign"}.csv`,
                  ledgerCsv(ledger),
                )
              }
            >
              Export this ledger (CSV)
            </s-button>
          </ActionRow>

          <LedgerTable
            rows={ledger}
            total={ledgerTotal}
            renderAction={(row) =>
              // Only rows this campaign actually wrote. Offering to revert a row that
              // failed or was skipped would promise to undo something that never
              // happened.
              row.status === "VERIFIED" || row.status === "APPLIED" ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="revert-variant" />
                  <input type="hidden" name="variantGid" value={row.variantGid} />
                  <s-button type="submit" variant="tertiary" loading={busy || undefined}>
                    Revert this variant
                  </s-button>
                </fetcher.Form>
              ) : (
                <s-text>—</s-text>
              )
            }
          />
        </s-section>
      ) : null}
    </>
  );
}
