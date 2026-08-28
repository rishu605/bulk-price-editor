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

import { humanise } from "../lib/format/label";
import { formatCount, formatWhen } from "../lib/format/display";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { baselineHistory, browseBaselines } from "../services/baseline-browser.server";
import { BaselineTable } from "../components/BaselineTable";
import { ActionRow } from "../components/ActionRow";
import { ImportForm, ImportReport, type ImportProblem } from "../components/imports/ImportForm";
import { importBaselines, type BaselineImportResult } from "../services/baseline-import.server";
import { importErrorCsv } from "../lib/reporting/baseline-errors";
import { shopCurrency } from "../services/settings.server";
import { actorFor } from "../lib/audit/actor";
import { linesOf } from "../lib/reporting/lines";
import { isCommit } from "../lib/imports/intent";
import { reportError } from "../services/error-report.server";
import { EmptyState, NoMatches } from "../components/AsyncState";
import { clearedSearch } from "../components/FilterForm";
import { VariantSearch } from "../components/prices/VariantSearch";
import { Pagination } from "../components/Pagination";
import { baselinesCsv } from "../lib/reporting/baselines-csv";
import { downloadCsv } from "../lib/reporting/csv";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { HelpNote } from "../components/HelpNote";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { SPACE } from "../lib/ui/spacing";

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

type ActionData = { ok: boolean; message: string; result?: BaselineImportResult; errorId?: string };

/**
 * Importing baselines, on the page that lists them.
 *
 * This was `/app/imports/baselines`, a tab in a nav section named after a verb — so
 * "Baselines" appeared twice in the sidebar, once meaning *look at them* and once meaning
 * *replace them from a file*. Both were right, which is what made it a bad question to
 * ask a merchant.
 *
 * The dry run is still the default and still falls safe. `isCommit` is the comparison
 * rather than a literal spelled out here, so the property is tested against the values
 * that arrive rather than by grepping this file for a string.
 */
export const action = withGuard(
  "/app/prices/baselines",
  async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
    const { session, sessionToken } = await authenticate.admin(request);
    const shop = await ensureShop(session.shop);
    const form = await request.formData();

    try {
      const dryRun = !isCommit(form.get("intent"));
      const result = await importBaselines(
        shop.id,
        linesOf(String(form.get("csv") ?? "")),
        await shopCurrency(shop.id),
        { dryRun, actor: actorFor(sessionToken, session.shop) },
      );

      return {
        ok: true,
        result,
        message: dryRun
          ? `${result.ready} of ${result.total} rows would be imported. Nothing has been written.`
          : `Imported ${result.written} baselines.` +
            (result.unchanged > 0
              ? ` ${result.unchanged} already matched and were left alone.`
              : ""),
      };
    } catch (error) {
      const reported = await reportError(error, {
        shopId: shop.id,
        shop: session.shop,
        route: "/app/prices/baselines",
      });
      return { ok: false, message: reported.userMessage, errorId: reported.errorId };
    }
  },
);

export default function Baselines() {
  const { rows, total, vendors, sources, page, filters, variantGid, history, timeZone } =
    useLoaderData<typeof loader>();
  const [params, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const result = data?.result;

  const problems: ImportProblem[] = result
    ? [
        ...result.invalid.map((problem) => ({ ...problem, kind: "Will not parse" })),
        ...result.unmatched.map((problem) => ({ ...problem, kind: "No match" })),
        ...result.ambiguous.map((problem) => ({ ...problem, kind: "Matches several" })),
      ].sort((a, b) => a.line - b.line)
    : [];

  // `variant` is in FILTER_FIELDS but is not a filter the merchant set — it is which row
  // they asked the history for. Counting it here would make an empty result claim to be
  // filtered on a page where nothing is.
  const filtered = Boolean(filters.q || filters.vendor || filters.source || filters.divergedOnly);


  const show = (gid: string) =>
    setSearchParams((params) => {
      params.set("variant", gid);
      return params;
    });

  return (
    <PageShell heading="Baselines">
      {data ? (
        <s-banner tone={data.ok ? "success" : "critical"}>
          <s-paragraph>{data.message}</s-paragraph>
          {data.errorId ? <s-paragraph>Reference {data.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}


      <s-section>
        {/* The card's blocks at section rhythm. It was set nowhere, so they ran together:
            the count landed directly under the Search button, close enough to read as a
            caption on the control above it rather than as the size of what came back. */}
        <s-stack direction="block" gap={SPACE.section}>
          <VariantSearch
            fields={FILTER_FIELDS}
            query={filters.q ?? ""}
            label="Title, SKU or variant ID"
            direction="block"
          >
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
                  {humanise(source)}
                </s-option>
              ))}
            </s-select>

            {/* Its own full row. A checkbox is a tick and a sentence, not a field, so
                a column sized for a select leaves it stranded in white space. */}
            <s-grid-item gridColumn="span 3">
              <s-checkbox
                name="diverged"
                value="1"
                label="Only variants whose live price differs from their baseline"
                checked={filters.divergedOnly || undefined}
              />
            </s-grid-item>
          </VariantSearch>

          {rows.length === 0 ? (
            filtered ? (
              <NoMatches
                noun="baselines"
                description="A baseline is the reference price every campaign computes from — captured at install, or imported from your own list."
                clearHref={clearedSearch(params, FILTER_FIELDS)}
              />
            ) : (
              <EmptyState
                title="No baselines captured yet"
                description="A baseline is the reference price every campaign computes from, which is what stops a second sale discounting the first one's price. Syncing your catalogue captures one for every variant."
                action={{ label: "Sync your catalogue", href: "/app" }}
              />
            )
          ) : (
            <>
              {/* The count and the export on one baseline, at item rhythm, because the
                  count is exactly what the export exports — saying that on one line is the
                  whole relationship between the two controls. Stacked, as they were, the
                  button read as belonging to the sentence above it. */}
              <ActionRow>
                <s-text fontVariantNumeric="tabular-nums">
                  {formatCount(total)} {total === 1 ? "baseline" : "baselines"}
                </s-text>
                {/* Exports what the filters currently show, not the whole catalogue. A
                    merchant who narrowed to one vendor means that vendor, and handing them
                    500K rows instead is not being generous. */}
                <s-button
                  type="button"
                  variant="tertiary"
                  icon="download"
                  onClick={() => downloadCsv("anchor-baselines.csv", baselinesCsv(rows))}
                >
                  Export these (CSV)
                </s-button>
              </ActionRow>

              <BaselineTable rows={rows} onShowHistory={show} />

              <Pagination page={page} total={total} pageSize={ROWS_PER_VIEW} noun="baselines" />
            </>
          )}
        </s-stack>
      </s-section>

      {variantGid && history.length > 0 ? (
        <s-section heading="Baseline history">
          <s-paragraph>
            <s-text>{variantGid}</s-text>
          </s-paragraph>
          <s-table>
            {/* One variant's baselines over time, so the row's identity is when it was
                captured, not what the number was. */}
            <s-table-header-row>
              <s-table-header listSlot="primary">Captured</s-table-header>
              <s-table-header listSlot="inline" format="currency">Price</s-table-header>
              <s-table-header listSlot="labeled" format="currency">Compare at</s-table-header>
              <s-table-header listSlot="labeled">Source</s-table-header>
              <s-table-header listSlot="labeled">Superseded</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((entry) => (
                <s-table-row key={entry.capturedAt}>
                  <s-table-cell>{formatWhen(entry.capturedAt, timeZone)}</s-table-cell>
                  <s-table-cell>
                    {entry.price}
                    {entry.current ? " (current)" : ""}
                  </s-table-cell>
                  <s-table-cell>{entry.compareAt ?? "—"}</s-table-cell>
                  <s-table-cell>{humanise(entry.source)}</s-table-cell>
                  <s-table-cell>
                    {entry.supersededAt ? formatWhen(entry.supersededAt, timeZone) : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

      <ImportForm
        heading="Import baselines from a spreadsheet"
        fetcher={fetcher}
        busy={busy}
        ready={result?.ready ?? null}
        commitLabel={(ready) => `Import ${ready} baselines`}
        placeholder={"Variant SKU,Price\nCH-1,129.00\nCH-2,149.00"}
        description={
          <>
            <s-paragraph>
              <s-text>
                If you keep an MSRP or list price elsewhere, import it here and
                &ldquo;20% off&rdquo; will mean 20% off that number — permanently, however
                many campaigns run in between.
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>
                One row per variant: a SKU, barcode or variant ID, then the price. A
                compare-at and a currency column are optional. Prices are read in your
                store&rsquo;s currency unless a row says otherwise, and must be plain
                numbers — 1299.00, not $1,299.00.
              </s-text>
            </s-paragraph>
          </>
        }
      />

      {result ? (
        <ImportReport
          heading={result.dryRun ? "What would happen" : "What happened"}
          counts={[
            { label: "Rows read", value: result.total },
            { label: "Ready", value: result.ready },
            { label: "Already correct", value: result.unchanged },
            { label: "Need attention", value: problems.length },
          ]}
          problems={problems}
          download={{
            filename: "baseline-import-errors.csv",
            csv: () => importErrorCsv(result),
          }}
        />
      ) : null}

      {/* Its own page, and deliberately still a link rather than a form here. Recapture
          is the most destructive thing this app can do, and `planRecapture` counts a
          scope that can be half a million variants and cross-references every running
          campaign — neither of which belongs on a page a merchant opens to look one
          price up. */}
      <s-section heading="Recapture baselines">
        <s-paragraph>
          <s-text>
            Replaces the reference price of every variant in scope with the price its
            storefront shows right now. Do it when your real prices have genuinely
            changed — never while a sale is running, or the sale price becomes the price
            you discount from next time.
          </s-text>
        </s-paragraph>
        <ActionRow>
          <s-button href="/app/prices/baselines/recapture">
            Check a scope and recapture
          </s-button>
        </ActionRow>
      </s-section>

      <HelpNote label="Reading this page">
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
      </HelpNote>
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
