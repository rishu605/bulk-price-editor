import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { reconcile } from "../services/reconciliation.server";
import { auditMirror } from "../services/mirror-audit.server";
import { toAdminClient } from "../services/admin-client.server";
import { reconciliationCsv } from "../lib/reporting/reconciliation-csv";
import { downloadCsv } from "../lib/reporting/csv";
import { ReconciliationTable } from "../components/ReconciliationTable";
import { FilterForm } from "../components/FilterForm";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";

/** Filters that ride in the query string, so a merchant can bookmark a view. */
export const RECONCILE_FIELDS = ["q", "surface", "campaign", "state"] as const;

export const loader = withGuard("/app/reconciliation", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";

  const page = await reconcile(
    shop.id,
    shop.domain,
    {
      q: url.searchParams.get("q") ?? undefined,
      priceListGid: url.searchParams.get("surface") ?? undefined,
      campaignId: url.searchParams.get("campaign") || undefined,
      driftedOnly: state === "drifted",
      offBaselineOnly: state === "off-baseline",
    },
    Number(url.searchParams.get("page") ?? 1) || 1,
  );

  return {
    ...page,
    selected: {
      q: url.searchParams.get("q") ?? "",
      surface: url.searchParams.get("surface") ?? "any",
      campaign: url.searchParams.get("campaign") ?? "",
      state,
    },
  };
});

export const action = withGuard("/app/reconciliation", async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  if (String(form.get("intent")) !== "spot-check") return { ok: false, message: "" };

  // The same audit the nightly sweep runs, at a size the merchant chose. Reusing it
  // rather than writing a second comparison is the point: a spot check that could
  // disagree with the nightly audit would undermine both.
  const size = Math.min(1000, Math.max(1, Number(form.get("size") ?? 100) || 100));
  const result = await auditMirror(toAdminClient(admin), shop.id, { size });

  return {
    ok: true,
    message:
      result.diverged === 0
        ? `Checked ${result.checked} prices against Shopify just now. Every one matched.`
        : `Checked ${result.checked} prices against Shopify just now. ${result.diverged} ` +
          `disagreed and have been corrected here — the storefront was always right.`,
  };
});

export default function Reconciliation() {
  const { rows, total, surfaces, campaigns, counts, selected } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="What is live, and why">
      <s-section>
        <s-paragraph>
          <s-text>
            Every price on every surface, next to the baseline it was computed from and
            the campaign that put it there. {total} rows.
          </s-text>
        </s-paragraph>

        {counts.drifted > 0 ? (
          <s-banner tone="warning">
            <s-paragraph>
              {counts.drifted} {counts.drifted === 1 ? "price is" : "prices are"} not what
              we wrote. Something changed them outside this app.
            </s-paragraph>
          </s-banner>
        ) : (
          <s-banner tone="success">
            <s-paragraph>
              Every price we have written is still exactly what we wrote.
              {counts.offBaseline > 0
                ? ` ${counts.offBaseline} are away from their baseline, which is what a running campaign looks like.`
                : ""}
            </s-paragraph>
          </s-banner>
        )}

        <FilterForm fields={RECONCILE_FIELDS}>
          <s-stack gap="base">
            <s-text-field name="q" label="Title, SKU or variant ID" defaultValue={selected.q} />

            <s-select name="surface" label="Surface">
              <s-option value="any" defaultSelected={selected.surface === "any"}>
                Every surface
              </s-option>
              {surfaces.map((surface) => (
                <s-option
                  key={surface.priceListGid || "base"}
                  value={surface.priceListGid}
                  defaultSelected={selected.surface === surface.priceListGid}
                >
                  {surface.name}
                  {surface.currency ? ` (${surface.currency})` : ""}
                </s-option>
              ))}
            </s-select>

            <s-select name="campaign" label="Controlled by">
              <s-option value="" defaultSelected={!selected.campaign}>
                Any campaign
              </s-option>
              {campaigns.map((campaign) => (
                <s-option
                  key={campaign.id}
                  value={campaign.id}
                  defaultSelected={selected.campaign === campaign.id}
                >
                  {campaign.name}
                </s-option>
              ))}
            </s-select>

            <s-select name="state" label="Show">
              <s-option value="" defaultSelected={!selected.state}>
                Everything
              </s-option>
              <s-option value="drifted" defaultSelected={selected.state === "drifted"}>
                Only prices that are not what we wrote
              </s-option>
              <s-option
                value="off-baseline"
                defaultSelected={selected.state === "off-baseline"}
              >
                Only prices away from their baseline
              </s-option>
            </s-select>

            <s-button type="submit">Filter</s-button>
          </s-stack>
        </FilterForm>
      </s-section>

      <s-section heading="Check against Shopify right now">
        <s-paragraph>
          <s-text>
            Reads a sample of prices straight from Shopify and compares them with what
            this page shows. Anything that disagrees is corrected here — the storefront
            is always the truth.
          </s-text>
        </s-paragraph>

        {fetcher.data?.message ? (
          <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="spot-check" />
          <s-stack direction="inline" gap="base">
            <s-number-field name="size" label="How many to check" defaultValue="100" />
            <s-button type="submit" loading={busy || undefined}>
              Check now
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Prices">
        <ReconciliationTable rows={rows} />

        <s-button
          type="button"
          variant="tertiary"
          onClick={() => downloadCsv("anchor-reconciliation.csv", reconciliationCsv(rows))}
        >
          Export this page (CSV)
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
