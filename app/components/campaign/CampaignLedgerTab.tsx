/**
 * Every row one run of this campaign wrote, with what it was and what we intended.
 *
 * Retained indefinitely on every plan -- it is the evidence behind every claim the rest
 * of the page makes, which is why it is a tab rather than something to scroll past.
 */

import { useState } from "react";

import { LedgerTable } from "../../components/LedgerTable";
import { ActionRow } from "../ActionRow";
import { filenameSlug } from "../../lib/reporting/csv";
import { ExportButton } from "../ExportButton";
import type { CampaignDetailProps } from "./props";
import { Card } from "../Card";
import { formatWhen } from "../../lib/format/display";
import { offersVariantRevert, wroteThisRow } from "../../lib/campaigns/variant-revert-offer";
import type { LedgerRow } from "../../services/campaigns/index.server";
import {
  VARIANT_REVERT_MODAL_ID,
  VariantRevertConfirmation,
  type VariantRevertTarget,
} from "./VariantRevertConfirmation";

export function CampaignLedgerTab({
  preview,
  ledger,
  ledgerTotal,
  ledgerRun,
  selectedRunId,
  state,
  rollback,
  excludedVariantGids = [],
  timeZone,
  fetcher,
  busy,
}: CampaignDetailProps) {
  const [target, setTarget] = useState<VariantRevertTarget | null>(null);

  // Only on an apply's rows, of a campaign that still has prices up (#764). It was offered
  // on every Verified row of whatever run the page showed -- by default the newest, so on a
  // campaign applied and then reverted it sat on every row of the revert, and pressing it
  // took the variant out of the campaign for good with nothing visible to show for it.
  const offered = offersVariantRevert(state, ledgerRun?.kind);

  // One button per variant, on its first row the run wrote. The action is the variant's,
  // not the row's: a campaign pricing two markets writes three rows for each variant, and
  // three identical buttons read as three separate reverts of three separate prices.
  const actionable = new Set<LedgerRow>();
  const seen = new Set<string>();
  for (const row of ledger) {
    if (!wroteThisRow(row.status) || seen.has(row.variantGid)) continue;
    seen.add(row.variantGid);
    actionable.add(row);
  }

  return (
    <>
      {ledger.length > 0 ? (
        <Card
          heading="Ledger"
          lede={describeRun(ledgerRun, timeZone)}
          secondary={
            offered
              ? "Retained indefinitely on every plan. Reverting a single variant takes it out of this campaign for good — including future scheduled runs — and recomputes its price without it."
              : "Retained indefinitely on every plan."
          }
        >
          <ActionRow>
            {/* Every row of the run, read on the server (#819). It was the ~60 on screen. */}
            {selectedRunId ? (
              <ExportButton
                href={`/app/export/ledger?run=${encodeURIComponent(selectedRunId)}`}
                filename={`ledger-${filenameSlug(preview.name) || "campaign"}.csv`}
                rows={ledgerTotal}
              />
            ) : null}
          </ActionRow>

          <LedgerTable
            rows={ledger}
            total={ledgerTotal}
            revert={ledgerRun?.kind === "REVERT"}
            renderAction={
              offered
                ? (row) =>
                    // Only rows this campaign actually wrote. Offering to revert a row that
                    // failed or was skipped would promise to undo something that never
                    // happened.
                    actionable.has(row) ? (
                      // Opens the confirmation rather than posting: one press writes a live
                      // price and changes the campaign's scope for good. Secondary, because
                      // it is the only control in the row and it writes a price, so it is
                      // the last thing in the app that should render as text.
                      <s-button
                        type="button"
                        variant="secondary"
                        loading={busy || undefined}
                        commandFor={VARIANT_REVERT_MODAL_ID}
                        command="--show"
                        accessibilityLabel={`Revert ${row.title}`}
                        onClick={() => setTarget(revertTarget(row, rollback, excludedVariantGids))}
                      >
                        Revert this variant
                      </s-button>
                    ) : (
                      <s-text>—</s-text>
                    )
                : undefined
            }
          />
        </Card>
      ) : null}

      {/* Outside the card, for the reason the header gives: a modal is not part of the
          row of things it sits beside, and its black button is not one of theirs. */}
      {offered ? (
        <VariantRevertConfirmation
          campaignName={preview.name}
          target={target}
          marketNames={preview.markets.map((market) => market.name)}
          busy={busy}
          onConfirm={() => {
            if (!target) return;
            fetcher.submit({ intent: "revert-variant", variantGid: target.variantGid }, { method: "post" });
          }}
        />
      ) : null}
    </>
  );
}

/**
 * What the confirmation says about the row pressed.
 *
 * The price is the rollback report's: planned by the revert's own planner with this
 * campaign left out, so the dialog cannot name a price the run will not write (rule 4).
 * The page already has the report for every campaign this button is offered on -- the
 * loader builds it for exactly the live states -- so asking costs nothing.
 */
export function revertTarget(
  row: Pick<LedgerRow, "variantGid" | "title">,
  rollback: { rows: ReadonlyArray<{ variantGid: string; revertsTo: string | null }> } | null,
  excludedVariantGids: readonly string[],
): VariantRevertTarget {
  return {
    variantGid: row.variantGid,
    title: row.title,
    revertsTo: rollback?.rows.find((candidate) => candidate.variantGid === row.variantGid)?.revertsTo ?? null,
    excluded: excludedVariantGids.includes(row.variantGid),
  };
}

/**
 * Which run this is, in words (#764).
 *
 * Nothing on the tab said, so a revert's rows -- "Before 0.28, Intended 0.40" -- read as
 * a price rise, and whoever opened the tab could not tell the evidence for the sale from
 * the evidence for its end.
 */
export function describeRun(
  run: { kind: string; startedAt: string | null; finishedAt: string | null; createdAt: string } | null | undefined,
  timeZone: string,
): string {
  if (!run) return "Every row we wrote, with what it was and what we intended.";

  const when = run.finishedAt
    ? `that finished ${formatWhen(run.finishedAt, timeZone)}`
    : run.startedAt
      ? `that started ${formatWhen(run.startedAt, timeZone)}`
      : `queued ${formatWhen(run.createdAt, timeZone)}`;

  return run.kind === "REVERT"
    ? `The revert ${when}: every price it put back, what each was before the revert, and what it was worked out to be without this campaign.`
    : `The apply ${when}: every price it wrote, what each was before, and what this campaign set it to.`;
}
