/**
 * What this campaign would do: counts, how long the run takes, approval, margins, markets
 * and the per-row preview.
 *
 * The largest of the tab bodies by a wide margin, which is most of why the page was 690
 * lines and every other section was below the fold.
 *
 * ## Four sections, not one section holding three
 *
 * Approval, margins and markets were each an `s-section` *inside* the `s-section` headed
 * Preview — a card in a card in a page, three borders deep, with the innermost heading
 * levelled as though it belonged to the outer card's content. `spacing.ts` is explicit
 * that a block needing a name but not a card gets a bare `s-heading`; these need more
 * than that, so they are siblings. `s-page` spaces its own sections, which is why the tab
 * body can be a fragment and nothing here sets page rhythm.
 *
 * ## Why approval comes first
 *
 * It is a gate. When a campaign is large enough to need a second person, that is the most
 * important thing on the tab and nothing below it can happen until it is answered. It
 * used to sit between the write path and the margins, above a preview table long enough
 * that the Approve and Decline buttons were reliably off screen.
 */

import { OverlapPanel } from "../OverlapPanel";
import { countOf, formatCount } from "../../lib/format/display";
import { confirmationReasons } from "../../lib/campaigns/blast-radius";
import { describeRunDuration } from "../../lib/planning/duration";
import { CountsRow } from "../../components/CountsRow";
import { PreviewTable } from "../../components/PreviewTable";
import { filenameSlug } from "../../lib/reporting/csv";
import { ExportButton } from "../ExportButton";
import { ActionRow } from "../ActionRow";
import type { CampaignDetailProps } from "./props";
import { Card } from "../Card";

export function CampaignPreviewTab({ preview, approval, fetcher, busy }: CampaignDetailProps) {
  // A run is writing this campaign: no plan was made, and none is needed (#803).
  if (preview.writing) {
    return (
      <Card heading="Preview">
        <s-paragraph>{preview.writing}</s-paragraph>
      </Card>
    );
  }

  return (
    <>

      {approval.required ? (
        <Card heading="Approval">      <s-paragraph>
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

          <ActionRow>
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
          </ActionRow>
        </Card>
      ) : null}

      {/* Which other live campaigns share these variants and who wins them (#821). Nothing
          renders when nothing overlaps. */}
      <OverlapPanel overlaps={preview.overlaps ?? []} />

      <Card heading="Preview">    <CountsRow
          items={[
            { label: "Will change", value: preview.counts.planned },
            { label: "Already correct", value: preview.counts.noop },
            { label: "Skipped", value: preview.counts.skipped },
            { label: "Clamped", value: preview.counts.clamped },
          ]}
        />

        {/* How long, and whether it carries on without them: the Apply dialog's own
            sentence. This printed the planner's reasoning -- "Write path: sync — 2 rows is
            under the 1000-row threshold and fits the available rate-limit budget" (#759).
            Nothing at all for a blocked plan, which is not going to run. */}
        {preview.blocked ? null : (
          <s-paragraph>
            <s-text>
              {describeRunDuration(preview.writePath === "bulk" ? "bulk" : "sync", preview.counts.planned)}
            </s-text>
          </s-paragraph>
        )}

        {/* Before Apply: these rows are discounted from, and reverted to, a price the
            merchant has since changed outside the app (#745). */}
        {preview.staleBaselines > 0 ? (
          <s-banner tone="warning">
            <s-paragraph>
              {preview.staleBaselines} of the prices this would write{" "}
              {preview.staleBaselines === 1 ? "was" : "were"} changed outside this app while no
              campaign was running on {preview.staleBaselines === 1 ? "it" : "them"}, so{" "}
              {preview.staleBaselines === 1 ? "its baseline is" : "their baselines are"} out of
              date. This campaign would discount from the old price, and ending it would put the
              old price back.
            </s-paragraph>
            <s-button href="/app/prices/baselines/recapture?segment=stale">Recapture baselines</s-button>
          </s-banner>
        ) : null}

        {/* The Apply dialog's reasons, so the tab and the dialog say the same thing (#818). */}
        {preview.blastRadius ? (
          <s-banner tone="warning">
            {(preview.confirm ? confirmationReasons(preview.confirm) : []).map((reason) => (
              <s-paragraph key={reason}>{reason}</s-paragraph>
            ))}
            <s-paragraph>Re-read the preview before applying: Apply will ask for the word typed.</s-paragraph>
          </s-banner>
        ) : null}

        <PreviewTable
          rows={preview.rows}
          markets={preview.markets}
          // A campaign for its markets alone writes no base price, so its rows are counted
          // apart (#1111): "6 of 0" otherwise.
          total={preview.marketsOnlyVariants ?? preview.counts.planned}
          alreadyCorrect={preview.counts.noop}
          blocked={Boolean(preview.blocked)}
        />

        <ActionRow>
          {/* Every planned row, read on the server (#819). It was the screenful on display,
              and the only way to review a large plan before typing "apply". */}
          <ExportButton
            href={`/app/export/preview?campaign=${encodeURIComponent(preview.campaignId)}`}
            filename={`preview-${filenameSlug(preview.name) || "campaign"}.csv`}
            rows={preview.counts.planned + preview.counts.skipped}
          />
        </ActionRow>
      </Card>

      {preview.margin ? (
        <Card heading="What this does to your margins">      <s-paragraph>
            <s-text>{preview.margin.summary}</s-text>
          </s-paragraph>
          <s-paragraph>
            {/* Said plainly, because overstating causality in a pricing tool is how
                merchants make expensive decisions on bad inference. */}
            <s-text color="subdued">
              This is arithmetic on your prices and costs. It does not predict what you
              will sell.
            </s-text>
          </s-paragraph>

          {preview.margin.belowCost.length > 0 ? (
            <s-banner tone="critical">
              <s-paragraph>
                {formatCount(preview.margin.belowCost.length)} of these would sell at or below cost:
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
                {formatCount(preview.margin.belowTarget.length)} would fall below your target margin,
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
        </Card>
      ) : null}

      {preview.markets.length > 0 ? (
        <Card heading="Markets">      <s-paragraph>
            <s-text>
              Each market is priced from its own normal price in its own currency,
              not converted from the base sale price.
            </s-text>
          </s-paragraph>

          {preview.markets.map((market) =>
            /* A refused market is the one thing on this card a merchant must not scroll
               past: every other market is priced, and this one silently will not be.
               Its own sentence already names the cause and the next action. */
            market.refused ? (
              <s-banner key={market.priceListGid} tone="critical">
                <s-paragraph>{market.explanation}</s-paragraph>
              </s-banner>
            ) : (
              <s-paragraph key={market.priceListGid}>
                <s-text>{market.explanation}</s-text>
                {/* Only what a guardrail did (#844). A skip has many causes -- a currency
                    mismatch, a missing import -- and the market's own sentence above names
                    them; counting them here as a guardrail's blamed the wrong thing. */}
                {market.clamped > 0 ? (
                  <s-text tone="caution">
                    {" "}
                    A guardrail raises {countOf(market.clamped, "variant")} to its floor here.
                  </s-text>
                ) : null}
              </s-paragraph>
            ),
          )}
        </Card>
      ) : null}
    </>
  );
}
