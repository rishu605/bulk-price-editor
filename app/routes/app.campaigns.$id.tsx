import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const campaignId = String(params.id);

  const [preview, runs, record] = await Promise.all([
    previewCampaign(shop.id, campaignId),
    campaignRuns(shop.id, campaignId),
    prisma.campaign.findFirstOrThrow({
      where: { id: campaignId, shopId: shop.id },
      select: { schedule: true },
    }),
  ]);

  const schedule = parseSchedule(record.schedule);
  const scheduleText = describeSchedule(schedule, shop.timezone);
  const warnings = scheduleWarnings(schedule);

  // Show the newest run's ledger inline. The first question after a run is always
  // "what exactly did it do to each variant", and making that a second click loses
  // the people who most need the answer.
  const requested = new URL(request.url).searchParams.get("run");
  const selectedRunId = requested ?? runs[0]?.id ?? null;
  const ledger = selectedRunId ? await runLedger(shop.id, selectedRunId) : [];

  return { preview, runs, ledger, selectedRunId, scheduleText, warnings };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const intent = String((await request.formData()).get("intent"));
  const reverting = intent === "revert";

  try {
    const result = await runCampaign(shop.id, String(params.id), toAdminClient(admin), {
      revert: reverting,
    });

    const verb = reverting ? "Reverted" : "Applied";
    return {
      ok: result.clean,
      message: result.clean
        ? `${verb} ${result.verified} variants, all verified.`
        : `${verb} with ${result.failed} failures and ${result.unverified} unverified. ` +
          `Nothing is hidden — resume to retry.`,
      details: result.messages,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      details: [] as string[],
    };
  }
};

type ActionData = { ok: boolean; message: string; details: string[] };

export default function CampaignDetail() {
  const { preview, runs, ledger, selectedRunId, scheduleText, warnings } =
    useLoaderData<typeof loader>();
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

      <s-section slot="aside" heading="Status">
        <s-paragraph>
          <s-badge>{preview.status}</s-badge>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
