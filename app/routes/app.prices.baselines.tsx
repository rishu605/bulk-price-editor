/**
 * Every variant's baseline, and where it came from.
 *
 * The question this exists to answer instantly is "why is this variant priced the way it
 * is?" — the one that arrives in support tickets constantly and that competitors answer
 * with a shrug.
 *
 * Debug-grade polish is deliberate at this stage: the audience is us and, later,
 * support. It grows into the merchant-facing reconciliation view (P5.6), which is the
 * same question asked more politely.
 *
 * Named `_index` rather than `app.baselines`, because flat routes would otherwise make
 * this file the *layout* for everything under /app/baselines — and a layout with no
 * `<Outlet />` renders itself in place of its children. Naming it `app.baselines` broke
 * both the import and recapture pages into showing this table instead.
 */

import { formatWhen } from "../lib/format/display";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { baselineHistory, browseBaselines } from "../services/baseline-browser.server";
import { BaselineTable } from "../components/BaselineTable";
import { FilterForm } from "../components/FilterForm";
import { baselinesCsv } from "../lib/reporting/baselines-csv";
import { downloadCsv } from "../lib/reporting/csv";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";

const FILTER_FIELDS = ["q", "vendor", "source", "diverged", "variant"] as const;

export const loader = withGuard("/app/prices/baselines", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const filters = {
    q: url.searchParams.get("q") ?? undefined,
    vendor: url.searchParams.get("vendor") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    divergedOnly: url.searchParams.get("diverged") === "1",
  };
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const result = await browseBaselines(shop.id, shop.domain, filters, page);

  // One variant's full story, when somebody has asked for it. Loaded here rather than
  // behind a second click, because the click is the thing support is trying to avoid.
  const variantGid = url.searchParams.get("variant");
  const history = variantGid ? await baselineHistory(shop.id, variantGid) : [];

  return { ...result, page, filters, variantGid, history, timeZone: shop.timezone };
});

export default function Baselines() {
  const { rows, total, vendors, sources, page, filters, variantGid, history, timeZone } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const lastPage = Math.max(1, Math.ceil(total / 25));
  const goTo = (next: number) =>
    setSearchParams((params) => {
      params.set("page", String(next));
      return params;
    });

  const show = (gid: string) =>
    setSearchParams((params) => {
      params.set("variant", gid);
      return params;
    });

  return (
    <PageShell heading="Baselines">
      <s-section>
        <FilterForm fields={FILTER_FIELDS}>
          <s-stack gap="base">
            <s-text-field name="q" label="Title, SKU or variant ID" value={filters.q ?? ""} />

            <s-select name="vendor" label="Vendor">
              <s-option value="" defaultSelected={!filters.vendor}>
                Any vendor
              </s-option>
              {vendors.map((vendor) => (
                <s-option key={vendor} value={vendor} defaultSelected={filters.vendor === vendor}>
                  {vendor}
                </s-option>
              ))}
            </s-select>

            <s-select name="source" label="Where the baseline came from">
              <s-option value="" defaultSelected={!filters.source}>
                Any source
              </s-option>
              {sources.map((source) => (
                <s-option key={source} value={source} defaultSelected={filters.source === source}>
                  {source.toLowerCase().replace(/_/g, " ")}
                </s-option>
              ))}
            </s-select>

            <s-checkbox
              name="diverged"
              value="1"
              label="Only variants whose live price differs from their baseline"
              checked={filters.divergedOnly || undefined}
            />

            <s-button type="submit">Filter</s-button>
          </s-stack>
        </FilterForm>

        {rows.length === 0 ? (
          <s-paragraph>
            Nothing matches. A baseline is the reference price every campaign computes
            from — captured at install, or imported from your own list.
          </s-paragraph>
        ) : (
          <>
            <s-paragraph>
              <s-text>
                {total} variants · showing {rows.length}
              </s-text>
            </s-paragraph>

            {/* Exports what the filters currently show, not the whole catalogue. A
                merchant who narrowed to one vendor means that vendor, and handing them
                500K rows instead is not being generous. */}
            <s-button
              type="button"
              variant="tertiary"
              onClick={() => downloadCsv("anchor-baselines.csv", baselinesCsv(rows))}
            >
              Export these baselines (CSV)
            </s-button>

            <BaselineTable rows={rows} onShowHistory={show} />

            {lastPage > 1 ? (
              <s-stack direction="inline" gap="base">
                <s-button disabled={page <= 1} onClick={() => goTo(page - 1)}>
                  Previous
                </s-button>
                <s-text>
                  Page {page} of {lastPage}
                </s-text>
                <s-button disabled={page >= lastPage} onClick={() => goTo(page + 1)}>
                  Next
                </s-button>
              </s-stack>
            ) : null}
          </>
        )}
      </s-section>

      {variantGid && history.length > 0 ? (
        <s-section heading="Baseline history">
          <s-paragraph>
            <s-text>{variantGid}</s-text>
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header>Price</s-table-header>
              <s-table-header>Compare at</s-table-header>
              <s-table-header>Source</s-table-header>
              <s-table-header>Captured</s-table-header>
              <s-table-header>Superseded</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((entry) => (
                <s-table-row key={entry.capturedAt}>
                  <s-table-cell>
                    {entry.price}
                    {entry.current ? " (current)" : ""}
                  </s-table-cell>
                  <s-table-cell>{entry.compareAt ?? "—"}</s-table-cell>
                  <s-table-cell>{entry.source.toLowerCase().replace(/_/g, " ")}</s-table-cell>
                  <s-table-cell>{formatWhen(entry.capturedAt, timeZone)}</s-table-cell>
                  <s-table-cell>
                    {entry.supersededAt ? formatWhen(entry.supersededAt, timeZone) : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      <s-section slot="aside" heading="Reading this page">
        <s-paragraph>
          <s-text>
            <strong>Baseline</strong> is the reference price every campaign computes from.
            It only changes when you recapture or import, so a discount is always measured
            against the real price rather than against a previous discount.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            A live price differing from the baseline is expected while a campaign is
            running. Outside one, it means something changed the price elsewhere.
          </s-text>
        </s-paragraph>
      </s-section>
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
