/**
 * Importing baselines from a file.
 *
 * Baselines captured at install are whatever the storefront happened to show that day.
 * For a merchant who maintains MSRP in an ERP, that is the wrong number — and it is the
 * number every campaign computes from, permanently. This is how they replace it.
 *
 * Dry run is the default and the button says so. A baseline is not a price you can
 * glance at afterwards and correct; it silently mis-prices every campaign from here on,
 * so reviewing before writing is the normal path rather than the careful one.
 */

import { humanise } from "../lib/format/label";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { shopCurrency } from "../services/settings.server";
import { importBaselines, type BaselineImportResult } from "../services/baseline-import.server";
import { importErrorCsv } from "../lib/reporting/baseline-errors";
import { downloadCsv } from "../lib/reporting/csv";
import { linesOf } from "../lib/reporting/lines";
import { actorFor } from "../lib/audit/actor";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { reportError } from "../services/error-report.server";
import { PageShell } from "../components/PageShell";
import { CsvDropZone } from "../components/imports/CsvDropZone";

export const loader = withGuard("/app/imports/baselines", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  return { currency: await shopCurrency(shop.id) };
});

type ActionData = { ok: boolean; message: string; result?: BaselineImportResult; errorId?: string };

export const action = withGuard("/app/imports/baselines", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const csv = String(form.get("csv") ?? "");
  const dryRun = String(form.get("intent")) !== "commit";

  try {
    const result = await importBaselines(
      shop.id,
      linesOf(csv),
      await shopCurrency(shop.id),
      { dryRun, actor: actorFor(sessionToken, session.shop) },
    );

    return {
      ok: true,
      result,
      message: dryRun
        ? `${result.ready} of ${result.total} rows would be imported. Nothing has been written.`
        : `Imported ${result.written} baselines.` +
          (result.unchanged > 0 ? ` ${result.unchanged} already matched and were left alone.` : ""),
    };
  } catch (error) {
    const reported = await reportError(error, {
      shopId: shop.id,
      shop: session.shop,
      route: "/app/imports/baselines",
    });
    return { ok: false, message: reported.userMessage, errorId: reported.errorId };
  }
});

export default function ImportBaselines() {
  const { currency } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const result = data?.result;

  const form = useRef<HTMLFormElement>(null);
  const intent = useRef<HTMLInputElement>(null);

  const submitWith = (value: string) => {
    if (intent.current) intent.current.value = value;
    form.current?.requestSubmit();
  };

  return (
    <PageShell heading="Import baselines">
      {data ? (
        <s-banner tone={data.ok ? "success" : "critical"}>
          <s-paragraph>{data.message}</s-paragraph>
          {data.errorId ? <s-paragraph>Reference {data.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}

      <s-section heading="Your reference prices">
        <s-paragraph>
          <s-text>
            Every campaign computes from a variant&rsquo;s baseline, not from its current
            price. If you keep an MSRP or list price elsewhere, import it here and
            &ldquo;20% off&rdquo; will mean 20% off that number — permanently, however
            many campaigns run in between.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            One row per variant: a SKU, barcode or variant ID, then the price. A
            compare-at and a currency column are optional. Prices are read in {currency}{" "}
            unless a row says otherwise, and must be plain numbers — 1299.00, not
            $1,299.00.
          </s-text>
        </s-paragraph>

        <fetcher.Form method="post" ref={form}>
          {/* `s-button` takes no name/value, so the intent rides in a hidden field the
              buttons set before submitting. One form, because both actions read the
              same rows and duplicating the textarea would let them drift apart. */}
          <input type="hidden" name="intent" ref={intent} value="dry-run" readOnly />
          <s-stack gap="base">
                        <CsvDropZone target="csv" />

                        <s-text-area
              name="csv"
              label="Rows"
              rows={12}
              details="One variant per line. Paste straight from a spreadsheet."
            />
            <s-stack direction="inline" gap="base">
              <s-button
                type="button"
                variant="primary"
                loading={busy || undefined}
                onClick={() => submitWith("dry-run")}
              >
                Check the file
              </s-button>
              <s-button
                type="button"
                tone="critical"
                loading={busy || undefined}
                disabled={!result || result.ready === 0 || undefined}
                onClick={() => submitWith("commit")}
              >
                Import {result?.ready ?? 0} baselines
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {result ? <ImportReport result={result} /> : null}

      <s-section slot="aside" heading="Why this is checked first">
        <s-paragraph>
          <s-text>
            A baseline is not a price you can glance at afterwards and correct. It is the
            number every future campaign computes from, so a wrong one quietly
            mis-prices a product on every sale from here on.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            Rows that match two variants are never guessed at. Choosing one could set the
            wrong product&rsquo;s reference price permanently, so they are listed for you
            to resolve with a variant ID instead.
          </s-text>
        </s-paragraph>
      </s-section>
    </PageShell>
  );
}

function ImportReport({ result }: { result: BaselineImportResult }) {
  const problems = [
    ...result.invalid.map((p) => ({ ...p, kind: "Will not parse" })),
    ...result.unmatched.map((p) => ({ ...p, kind: "No match" })),
    ...result.ambiguous.map((p) => ({ ...p, kind: "Matches several" })),
  ].sort((a, b) => a.line - b.line);

  return (
    <s-section heading={result.dryRun ? "What would happen" : "What happened"}>
      <s-paragraph>
        <s-text>
          {result.total} rows read · {result.ready} ready · {result.unchanged} already
          correct · {problems.length} need attention
        </s-text>
      </s-paragraph>

      {problems.length === 0 ? (
        <s-paragraph>
          <s-text>Every row matched a variant and validated.</s-text>
        </s-paragraph>
      ) : (
        <>
          <s-stack direction="inline" gap="base">
            <s-paragraph>
              <s-text>
                These rows were left out. Everything else is unaffected — one bad row
                never fails the file.
              </s-text>
            </s-paragraph>
            <s-button
              type="button"
              variant="tertiary"
              onClick={() => downloadCsv("baseline-import-errors.csv", importErrorCsv(result))}
            >
              Download the list
            </s-button>
          </s-stack>

          <s-table>
            <s-table-header-row>
              <s-table-header>Line</s-table-header>
              <s-table-header>Identifier</s-table-header>
              <s-table-header>Problem</s-table-header>
              <s-table-header>What to do</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {problems.slice(0, 25).map((problem) => (
                <s-table-row key={`${problem.line}-${problem.identifier}`}>
                  <s-table-cell>{problem.line}</s-table-cell>
                  <s-table-cell>{problem.identifier || "—"}</s-table-cell>
                  <s-table-cell>{humanise(problem.kind)}</s-table-cell>
                  <s-table-cell>{problem.reason}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </>
      )}
    </s-section>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
