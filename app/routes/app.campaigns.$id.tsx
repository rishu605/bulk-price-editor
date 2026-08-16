import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { previewCampaign, runCampaign } from "../services/campaigns.server";
import { toAdminClient } from "../services/admin-client.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const preview = await previewCampaign(shop.id, String(params.id));
  return { preview };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    const result = await runCampaign(shop.id, String(params.id), toAdminClient(admin), {
      revert: intent === "revert",
    });

    return {
      ok: result.clean,
      message: result.clean
        ? `${intent === "revert" ? "Reverted" : "Applied"} ${result.verified} variants, all verified.`
        : `${intent === "revert" ? "Revert" : "Apply"} finished with ${result.failed} failures and ${result.unverified} unverified. Nothing is being hidden — resume to retry.`,
      details: result.messages,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      details: [],
    };
  }
};

type ActionData = { ok: boolean; message: string; details: string[] };

type Tone = "info" | "success" | "critical" | "neutral" | "warning" | "caution" | "auto";

const STATUS_TONE: Record<string, Tone> = {
  pending: "info",
  clamped: "warning",
  skipped: "neutral",
};

export default function CampaignDetail() {
  const { preview } = useLoaderData<typeof loader>();
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
            Blocked by a guardrail on {preview.blocked.variantGid}: {preview.blocked.reason}.
            No prices were changed — a blocking guardrail stops the whole run, not just
            the offending variant.
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Preview">
        <s-stack direction="inline" gap="large">
          <s-box>
            <s-text>Will change</s-text>
            <s-heading>{preview.counts.planned}</s-heading>
          </s-box>
          <s-box>
            <s-text>Already correct</s-text>
            <s-heading>{preview.counts.noop}</s-heading>
          </s-box>
          <s-box>
            <s-text>Skipped</s-text>
            <s-heading>{preview.counts.skipped}</s-heading>
          </s-box>
          <s-box>
            <s-text>Clamped</s-text>
            <s-heading>{preview.counts.clamped}</s-heading>
          </s-box>
        </s-stack>

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

        {preview.rows.length > 0 ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>Variant</s-table-header>
              <s-table-header>Before</s-table-header>
              <s-table-header>After</s-table-header>
              <s-table-header>Compare at</s-table-header>
              <s-table-header>State</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {preview.rows.map((row) => (
                <s-table-row key={row.variantGid}>
                  <s-table-cell>{row.title}</s-table-cell>
                  <s-table-cell>{row.before ?? "—"}</s-table-cell>
                  <s-table-cell>{row.after ?? "—"}</s-table-cell>
                  <s-table-cell>{row.compareAt ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[row.status] ?? "neutral"}>
                      {row.status}
                      {row.reason ? ` · ${row.reason}` : ""}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>
            Nothing to change. Either every variant already shows the target price, or
            the scope matched no variants with baselines.
          </s-paragraph>
        )}
      </s-section>

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
