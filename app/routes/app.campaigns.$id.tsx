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
  runCampaign,
  runLedger,
} from "../services/campaigns/index.server";
import { describeSchedule, parseSchedule, scheduleWarnings } from "../lib/scheduling/window";
import { CountsRow } from "../components/CountsRow";
import { LedgerTable } from "../components/LedgerTable";
import { PreviewTable } from "../components/PreviewTable";
import { RunHistoryTable } from "../components/RunHistoryTable";
import { RouteBoundary } from "../components/RouteBoundary";
import { reportError } from "../services/error-report.server";
import { withGuard } from "../lib/errors/guard.server";
import {
  describeState,
  needsAttention,
  type CampaignState,
} from "../lib/lifecycle/transitions";
import { transitionHistory } from "../services/campaigns/lifecycle.server";

export const loader = withGuard("/app/campaigns/$id", async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const campaignId = String(params.id);

  const [preview, runs, record] = await Promise.all([
    previewCampaign(shop.id, campaignId),
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

  return {
    preview,
    runs,
    ledger,
    selectedRunId,
    scheduleText,
    warnings,
    autoEnroll: record.autoEnroll,
    enrollPendingAt: record.enrollPendingAt !== null,
    state,
    lifecycle,
    needsAttention: needsAttention(state),
    history,
  };
});

export const action = withGuard("/app/campaigns/$id", async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const intent = String((await request.formData()).get("intent"));
  const reverting = intent === "revert";

  try {
    // Resume is an ordinary apply. The resolver is idempotent, so rows already at the
    // campaign price are planned as "already correct" and cost nothing — only the ones
    // that failed last time are written again. A separate retry path would be a second
    // implementation of the same thing, free to disagree with the first.
    const result = await runCampaign(shop.id, String(params.id), toAdminClient(admin), {
      revert: reverting,
      resume: intent === "resume",
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
    preview,
    runs,
    ledger,
    selectedRunId,
    scheduleText,
    warnings,
    autoEnroll,
    enrollPendingAt,
    lifecycle,
    needsAttention: attention,
    history,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const canApply = preview.counts.planned > 0 && !preview.blocked;

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

      {ledger.length > 0 ? (
        <s-section heading="Ledger">
          <s-paragraph>
            <s-text>
              Every row we wrote, with what it was and what we intended. Retained
              indefinitely on every plan.
            </s-text>
          </s-paragraph>
          <LedgerTable rows={ledger} />
        </s-section>
      ) : null}

      <s-section slot="aside" heading="Actions">
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

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="revert" />
            <s-button type="submit" tone="critical" loading={busy || undefined}>
              Revert
            </s-button>
          </fetcher.Form>
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
