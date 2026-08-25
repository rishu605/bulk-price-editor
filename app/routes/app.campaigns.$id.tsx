import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { toAdminClient } from "../services/admin-client.server";
import {
  campaignRuns,
  previewCampaign,
  reinstateVariant,
  revertVariant,
  rollbackReport,
  runCampaign,
  runLedger,
} from "../services/campaigns/index.server";
import { describeSchedule, parseSchedule, scheduleWarnings } from "../lib/scheduling/window";
import { CountsRow } from "../components/CountsRow";
import { LedgerTable } from "../components/LedgerTable";
import { RollbackReportTable } from "../components/RollbackReportTable";
import { downloadCsv, filenameSlug } from "../lib/reporting/csv";
import { rollbackReportCsv } from "../lib/reporting/rollback";
import { PreviewTable } from "../components/PreviewTable";
import { RunHistoryTable } from "../components/RunHistoryTable";
import { RouteBoundary } from "../components/RouteBoundary";
import { reportError } from "../services/error-report.server";
import { withGuard } from "../lib/errors/guard.server";
import { actorFor } from "../lib/audit/actor";
import { isPractice } from "../services/campaigns/model.server";
import {
  canTransition,
  describeState,
  needsAttention,
  type CampaignState,
} from "../lib/lifecycle/transitions";
import { transitionHistory } from "../services/campaigns/lifecycle.server";

export const loader = withGuard("/app/campaigns/$id", async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const campaignId = String(params.id);

  const [preview, runs, record] = await Promise.all([
    // The client lets the review step say how each market will actually be written.
    // Without it the preview says the choice is made at run time, which is honest but
    // less useful than the answer.
    previewCampaign(shop.id, campaignId, { client: toAdminClient(admin) }),
    campaignRuns(shop.id, campaignId),
    prisma.campaign.findFirstOrThrow({
      where: { id: campaignId, shopId: shop.id },
      select: {
        schedule: true,
        autoEnroll: true,
        enrollPendingAt: true,
        status: true,
      },
    }),
  ]);

  const state = record.status as CampaignState;
  const practice = isPractice(record);
  const lifecycle = describeState(state);
  const history = await transitionHistory(shop.id, campaignId, 8);

  const schedule = parseSchedule(record.schedule);
  const scheduleText = describeSchedule(schedule, shop.timezone);
  const warnings = scheduleWarnings(schedule);

  // Show the newest run's ledger inline. The first question after a run is always
  // "what exactly did it do to each variant", and making that a second click loses
  // the people who most need the answer.
  const requested = new URL(request.url).searchParams.get("run");
  const selectedRunId = requested ?? runs[0]?.id ?? null;
  const ledger = selectedRunId ? await runLedger(shop.id, selectedRunId) : [];

  // Only for a campaign that has actually written something and could still be
  // reverted. It costs a full plan, and on a draft it would be a report about
  // nothing -- the honest answer there is that there is nothing to roll back.
  const revertable = state === "ACTIVE" || state === "PARTIAL" || state === "HELD";
  const rollback =
    revertable && runs.some((run) => run.kind === "APPLY")
      ? await rollbackReport(shop.id, campaignId)
      : null;

  return {
    rollback,
    preview,
    runs,
    ledger,
    selectedRunId,
    scheduleText,
    warnings,
    autoEnroll: record.autoEnroll,
    enrollPendingAt: record.enrollPendingAt !== null,
    state,
    practice,
    lifecycle,
    needsAttention: needsAttention(state),
    history,
  };
});

export const action = withGuard("/app/campaigns/$id", async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const actor = actorFor(sessionToken, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const reverting = intent === "revert";

  try {
    // Reverting one variant out of a running campaign, rather than ending the whole
    // thing. The exclusion is durable, so tonight's scheduled run leaves it alone too.
    if (intent === "revert-variant" || intent === "reinstate-variant") {
      const variantGid = String(form.get("variantGid"));
      const result =
        intent === "revert-variant"
          ? await revertVariant(shop.id, String(params.id), variantGid, toAdminClient(admin), {
              actor,
              excludeOnly: form.get("excludeOnly") === "1",
            })
          : await reinstateVariant(shop.id, String(params.id), variantGid, toAdminClient(admin), {
              actor,
            });

      return {
        ok: result.outcome ? result.outcome.clean : true,
        message: result.message,
        details: result.outcome?.messages ?? [],
      };
    }

    // Resume is an ordinary apply. The resolver is idempotent, so rows already at the
    // campaign price are planned as "already correct" and cost nothing — only the ones
    // that failed last time are written again. A separate retry path would be a second
    // implementation of the same thing, free to disagree with the first.
    const result = await runCampaign(shop.id, String(params.id), toAdminClient(admin), {
      revert: reverting,
      resume: intent === "resume",
      // Rows the merchant ticked "leave as it is" in the rollback report. Only
      // meaningful on a revert; an apply has no drifted-row conversation to honour.
      skipVariantGids: reverting ? form.getAll("keep").map(String) : undefined,
    });

    const verb = reverting ? "Reverted" : intent === "resume" ? "Resumed" : "Applied";

    // Another worker already owns this occurrence, so this call wrote nothing. It is
    // clean and it verified zero rows, which would otherwise render as "Applied 0
    // variants, all verified" -- technically true and completely misleading about
    // what is happening to the merchant's prices right now.
    if (result.deferredTo) {
      return { ok: true, message: result.messages[0], details: [] };
    }

    return {
      ok: result.clean,
      message: result.clean
        ? `${verb} ${result.verified} variants, all verified.`
        : `${verb} with ${result.failed} failures and ${result.unverified} unverified. ` +
          `Nothing is hidden — resume to retry.`,
      details: result.messages,
    };
  } catch (error) {
    // A failed run is the highest-stakes error in the app: the merchant needs to know
    // their prices are intact, in words, plus a reference that leads us to the stack.
    const reported = await reportError(error, {
      shopId: shop.id,
      shop: session.shop,
      route: "/app/campaigns/$id",
      method: "POST",
      campaignId: String(params.id),
      intent,
    });

    return {
      ok: false,
      message: reported.userMessage,
      details: [`Reference ${reported.errorId}`],
      errorId: reported.errorId,
    };
  }
});

type ActionData = {
  ok: boolean;
  message: string;
  details: string[];
  errorId?: string;
};

export default function CampaignDetail() {
  const {
    rollback,
    practice,
    preview,
    runs,
    ledger,
    selectedRunId,
    scheduleText,
    warnings,
    autoEnroll,
    enrollPendingAt,
    lifecycle,
    state,
    needsAttention: attention,
    history,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  // Gated on the lifecycle and on guardrails, deliberately not on "would this write
  // anything". A campaign whose prices already match -- because a merchant set them by
  // hand, or because an earlier run got there first -- still needs to be applied to
  // take ownership of them. Requiring rows to write left such a campaign stuck in
  // Draft forever, which also meant nothing would ever revert those prices.
  // A practice campaign can never be applied — the run path refuses it outright. The
  // button is not merely disabled: offering a control that exists only to be refused
  // undermines the promise the merchant was given when they chose practice.
  const canApply = !practice && !preview.blocked && canTransition(state, "APPLYING");

  return (
    <s-page heading={preview.name}>
      {result ? (
        <s-banner tone={result.ok ? "success" : "critical"}>
          <s-paragraph>{result.message}</s-paragraph>
          {result.details.map((detail) => (
            <s-paragraph key={detail}>{detail}</s-paragraph>
          ))}
        </s-banner>
      ) : null}

      {attention ? (
        <s-banner tone={lifecycle.tone === "critical" ? "critical" : "warning"}>
          <s-paragraph>{lifecycle.label}</s-paragraph>
          <s-paragraph>{lifecycle.explanation}</s-paragraph>
          {lifecycle.nextAction?.intent === "drift" ? (
            <s-button href="/app/drift">{lifecycle.nextAction.label}</s-button>
          ) : null}
        </s-banner>
      ) : null}

      {preview.blocked ? (
        <s-banner tone="critical">
          <s-paragraph>
            Blocked by a guardrail on {preview.blocked.variantGid}:{" "}
            {preview.blocked.reason}. No prices were changed — a blocking guardrail
            stops the whole run, not just the offending variant.
          </s-paragraph>
        </s-banner>
      ) : null}

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

        <PreviewTable rows={preview.rows} />
      </s-section>

      {runs.length > 0 ? (
        <s-section heading="Run history">
          <RunHistoryTable runs={runs} selectedRunId={selectedRunId} />
        </s-section>
      ) : null}

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
          <LedgerTable
            rows={ledger}
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

      <s-section slot="aside" heading="Actions">
        {practice ? (
          <s-banner tone="info">
            <s-paragraph>
              This is a practice campaign. The preview above is exactly what would
              happen, and nothing has been or will be written to your storefront.
              Create a real campaign with the same scope and rule when you are ready.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-stack gap="base">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="apply" />
            <s-button
              type="submit"
              variant="primary"
              loading={busy || undefined}
              disabled={!canApply}
            >
              Apply to storefront
            </s-button>
          </fetcher.Form>

          {lifecycle.nextAction?.intent === "resume" ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="resume" />
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                Resume — retry the rows that did not complete
              </s-button>
            </fetcher.Form>
          ) : null}

          {rollback && !rollback.straightforward ? (
            // Deliberately not a button. There are edits to decide about, and a
            // one-click revert here would silently overwrite them -- the decision
            // belongs in the report, where the merchant can see what they are
            // choosing between.
            <s-paragraph>
              <s-text>
                {rollback.counts.drifted} variant
                {rollback.counts.drifted === 1 ? " has" : "s have"} been changed since
                this campaign set {rollback.counts.drifted === 1 ? "it" : "them"}.
                Review them above before reverting.
              </s-text>
            </s-paragraph>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="revert" />
              <s-button type="submit" tone="critical" loading={busy || undefined}>
                Revert
              </s-button>
            </fetcher.Form>
          )}
        </s-stack>

        <s-paragraph>
          <s-text>
            Reverting recomputes each price without this campaign. If another campaign
            still covers a variant, that campaign&rsquo;s price stays — it does not
            snap back to full price.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Schedule">
        <s-paragraph>{scheduleText}</s-paragraph>
        {warnings.map((warning) => (
          <s-banner key={warning} tone="warning">
            <s-paragraph>{warning}</s-paragraph>
          </s-banner>
        ))}
      </s-section>

      <s-section slot="aside" heading="New products">
        <s-paragraph>
          {autoEnroll
            ? "Products that enter this campaign's scope while it runs are priced automatically, from their own normal price."
            : "Products added while this campaign runs are left at their current price."}
        </s-paragraph>
        {enrollPendingAt ? (
          <s-banner tone="info">
            <s-paragraph>
              New products found; they are priced on the next scheduler run.
            </s-paragraph>
          </s-banner>
        ) : null}
      </s-section>

      <s-section slot="aside" heading="Status">
        <s-paragraph>
          <s-badge tone={lifecycle.tone}>{lifecycle.label}</s-badge>
        </s-paragraph>
        <s-paragraph>
          <s-text>{lifecycle.explanation}</s-text>
        </s-paragraph>

        {history.length > 0 ? (
          <>
            <s-divider />
            <s-paragraph>
              <s-text>How it got here</s-text>
            </s-paragraph>
            {history.map((entry) => (
              <s-paragraph key={`${entry.at}-${entry.to}`}>
                <s-text>
                  {entry.from} → {entry.to} · {entry.reason || entry.actor}
                </s-text>
              </s-paragraph>
            ))}
          </>
        ) : null}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
