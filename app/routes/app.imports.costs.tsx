/**
 * Importing unit costs.
 *
 * The margin guardrail is the safety feature merchants ask for most, and on most
 * catalogues it protects nothing: Shopify does not require a cost, and a store built from
 * a supplier feed keeps costs in the supplier's spreadsheet. "Never price below cost"
 * then quietly skips every variant — switched on, reassuring, and inert. This is how a
 * merchant makes it real.
 *
 * Dry run is the default here as it is for baselines, though the stakes are different: a
 * wrong cost is a wrong floor rather than a wrong price. It stays the default anyway,
 * because a merchant who has just imported ten thousand costs should get to look before
 * the guardrail starts refusing to price things.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { shopCurrency } from "../services/settings.server";
import { importCosts, type CostImportResult } from "../services/cost-import.server";
import { costErrorCsv } from "../lib/reporting/cost-errors";
import { downloadCsv } from "../lib/reporting/csv";
import { actorFor } from "../lib/audit/actor";
import { linesOf } from "../lib/reporting/lines";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { reportError } from "../services/error-report.server";
import { PageShell } from "../components/PageShell";
import { UnsavedChanges } from "../components/UnsavedChanges";
import { CsvDropZone } from "../components/imports/CsvDropZone";

export const loader = withGuard("/app/imports/costs", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [currency, withCost, variants] = await Promise.all([
    shopCurrency(shop.id),
    prisma.variantIndex.count({ where: { shopId: shop.id, cost: { not: null }, deletedAt: null } }),
    prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } }),
  ]);

  return { currency, withCost, variants };
});

type ActionData = { ok: boolean; message: string; result?: CostImportResult; errorId?: string };

export const action = withGuard("/app/imports/costs", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const csv = String(form.get("csv") ?? "");
  const dryRun = String(form.get("intent")) !== "commit";

  try {
    const result = await importCosts(shop.id, linesOf(csv), await shopCurrency(shop.id), {
      dryRun,
      actor: actorFor(sessionToken, session.shop),
    });

    return {
      ok: true,
      result,
      message: dryRun
        ? `${result.ready} of ${result.total} rows would be imported. Nothing has been written.`
        : `Imported ${result.written} costs.` +
          (result.unchanged > 0
            ? ` ${result.unchanged} already matched and were left alone.`
            : ""),
    };
  } catch (error) {
    const reported = await reportError(error, {
      shopId: shop.id,
      shop: session.shop,
      route: "/app/imports/costs",
    });
    return { ok: false, message: reported.userMessage, errorId: reported.errorId };
  }
});

export default function ImportCosts() {
  const { currency, withCost, variants } = useLoaderData<typeof loader>();
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

  const coverage = variants === 0 ? 0 : Math.round((withCost / variants) * 100);
  const problems = result
    ? [...result.invalid, ...result.unmatched, ...result.ambiguous]
    : [];

  return (
    <PageShell heading="Import costs">
      {/* A pasted CSV can be fifty thousand rows, and none of it exists anywhere until
          the import runs. */}
      <UnsavedChanges
        form={form}
        describe="this import"
        saved={Boolean(fetcher.data)}
      />
      {data ? (
        <s-banner tone={data.ok ? "success" : "critical"}>
          <s-paragraph>{data.message}</s-paragraph>
          {data.errorId ? <s-paragraph>Reference {data.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}

      <s-section heading="What your cost floors can protect">
        <s-paragraph>
          <s-text>
            {withCost} of {variants} variants have a cost ({coverage}%). Cost-based
            guardrails only constrain variants that have one — the rest are skipped, so
            a low number here means &ldquo;never price below cost&rdquo; is doing less
            than it looks.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            One row per variant: a SKU, barcode or variant ID, then the cost. Costs are
            read in {currency} unless a row says otherwise, and must be plain numbers —
            12.50, not $12.50. A file exported from Matrixify works as it is.
          </s-text>
        </s-paragraph>

        <fetcher.Form method="post" ref={form}>
          {/* `s-button` takes no name/value, so the intent rides in a hidden field the
              buttons set before submitting. One form, because both actions read the same
              rows and duplicating the field would let them drift apart. */}
          <input type="hidden" name="intent" ref={intent} value="dry-run" readOnly />
          <s-stack gap="base">
            <CsvDropZone target="csv" />

            <s-text-area
              name="csv"
              label="Rows"
              rows={12}
              placeholder={"Variant SKU,Variant Cost\nCH-1,12.50\nCH-2,14.00"}
              details="Paste straight from a spreadsheet. A header row is read if there is one."
            />

            <s-stack direction="inline" gap="base">
              <s-button
                type="button"
                variant="primary"
                loading={busy || undefined}
                onClick={() => submitWith("dry-run")}
              >
                Check without importing
              </s-button>
              <s-button
                type="button"
                tone="critical"
                loading={busy || undefined}
                onClick={() => submitWith("commit")}
              >
                Import these costs
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {result ? (
        <s-section heading="What happened">
          <s-paragraph>
            <s-text>
              {result.total} rows read · {result.ready} ready · {result.written} written ·{" "}
              {result.unchanged} unchanged · {problems.length} need attention
            </s-text>
          </s-paragraph>

          {problems.length > 0 ? (
            <>
              <s-button
                type="button"
                variant="tertiary"
                onClick={() => downloadCsv("cost-import-errors.csv", costErrorCsv(result))}
              >
                Download the rows that need fixing (CSV)
              </s-button>

              <s-unordered-list>
                {problems.slice(0, 25).map((problem) => (
                  <s-list-item key={`${problem.line}-${problem.identifier}`}>
                    Line {problem.line} ({problem.identifier || "no identifier"}):{" "}
                    {problem.reason}
                  </s-list-item>
                ))}
              </s-unordered-list>
            </>
          ) : null}
        </s-section>
      ) : null}
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
