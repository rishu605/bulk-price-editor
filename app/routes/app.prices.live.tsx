import { formatCount } from "../lib/format/display";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { reconcile } from "../services/reconciliation.server";
import { auditMirror } from "../services/mirror-audit.server";
import { toAdminClient } from "../services/admin-client.server";
import { reconciliationCsv } from "../lib/reporting/reconciliation-csv";
import { downloadCsv } from "../lib/reporting/csv";
import { ReconciliationTable } from "../components/ReconciliationTable";
import { clearedSearch } from "../components/FilterForm";
import { Pagination } from "../components/Pagination";
// The size the pager counts by comes from the scale, not from the service that queries
// with it. Importing it from `reconciliation.server` compiled and passed every test, and
// failed the *build*: a `.server` module referenced by anything a route exports besides
// its loader is pulled into the client bundle, which React Router refuses. Both sides
// read `ROWS_PER_VIEW`, so they cannot disagree either way.
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { VariantSearch } from "../components/prices/VariantSearch";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { Field } from "../components/FieldGrid";
import { SPACE } from "../lib/ui/spacing";
import { Card } from "../components/Card";
import { TableBlock } from "../components/TableBlock";

/** Filters that ride in the query string, so a merchant can bookmark a view. */
export const RECONCILE_FIELDS = ["q", "surface", "campaign", "state"] as const;

export const loader = withGuard("/app/prices/live", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";

  // `page` is the number; `result` is the page of rows. They were one name, which is
  // most of why the pager was missing: `{...page}` looked like it spread a page number.
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const result = await reconcile(
    shop.id,
    shop.domain,
    {
      q: url.searchParams.get("q") ?? undefined,
      priceListGid: url.searchParams.get("surface") ?? undefined,
      campaignId: url.searchParams.get("campaign") || undefined,
      driftedOnly: state === "drifted",
      offBaselineOnly: state === "off-baseline",
    },
    page,
  );

  return {
    ...result,
    page,
    selected: {
      q: url.searchParams.get("q") ?? "",
      surface: url.searchParams.get("surface") ?? "any",
      campaign: url.searchParams.get("campaign") ?? "",
      state,
    },
  };
});

export const action = withGuard("/app/prices/live", async ({ request }: ActionFunctionArgs) => {
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
  const { rows, total, page, surfaces, campaigns, counts, selected } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const busy = fetcher.state !== "idle";

  return (
    /* The tab's own words. It read "What is live, and why" under a tab saying "What's
        live" — the heading was answering a second question the tab had not asked, and the
        sentence below already answers it better than a title can. */
    <PageShell heading="What's live">
      <s-section>
        <s-paragraph>
          <s-text>
            Every price on every surface, next to the baseline it was computed from and
            the campaign that put it there. {formatCount(total)} rows.
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

        <VariantSearch
          fields={RECONCILE_FIELDS}
          query={selected.q}
          label="Title, SKU or variant ID"
          direction="block"
        >

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

        </VariantSearch>
      </s-section>

      <Card heading="Check against Shopify right now">    <s-paragraph>
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
          {/* A field and the button that acts on it are one control, so they share a
              baseline at item rhythm. At section rhythm they read as two separate
              things that happen to be adjacent. */}
          <s-stack direction="inline" gap={SPACE.item} alignItems="end">
            <Field width="short">
              <s-number-field name="size" label="How many to check" value="100" />
            </Field>
            <s-button type="submit" loading={busy || undefined}>
              Check now
            </s-button>
          </s-stack>
        </fetcher.Form>
      </Card>

      <Card heading="Prices">
        {/* This page has been paged server-side since it was written and had no pager, so
            row 26 was unreachable by anything but typing `?page=2` into a URL a merchant
            cannot see. The loader already read the parameter and the service already
            returned the total; only the control was missing. */}
        <TableBlock
          pagination={<Pagination page={page} total={total} pageSize={ROWS_PER_VIEW} noun="prices" />}
        >
          <ReconciliationTable rows={rows} clearHref={clearedSearch(params, RECONCILE_FIELDS)} />
        </TableBlock>

        <s-button
          type="button"
          variant="tertiary"
          icon="download"
          onClick={() => downloadCsv("anchor-reconciliation.csv", reconciliationCsv(rows))}
        >
          Export this page (CSV)
        </s-button>
      </Card>
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
