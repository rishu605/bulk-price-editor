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
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { shopCurrency } from "../services/settings.server";
import { importCosts, type CostImportResult } from "../services/cost-import.server";
import { costErrorCsv } from "../lib/reporting/cost-errors";
import { actorFor } from "../lib/audit/actor";
import { linesOf } from "../lib/reporting/lines";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { reportError } from "../services/error-report.server";
import { PageShell } from "../components/PageShell";
import { formatCount } from "../lib/format/display";
import {
  ImportForm,
  ImportReport,
  type ImportProblem,
} from "../components/imports/ImportForm";

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


  const coverage = variants === 0 ? 0 : Math.round((withCost / variants) * 100);
  const problems: ImportProblem[] = result
    ? [
        ...result.invalid.map((p) => ({ ...p, kind: "Will not parse" })),
        ...result.unmatched.map((p) => ({ ...p, kind: "No match" })),
        ...result.ambiguous.map((p) => ({ ...p, kind: "Matches several" })),
      ].sort((a, b) => a.line - b.line)
    : [];

  return (
    <PageShell heading="Import costs">
      {data ? (
        <s-banner tone={data.ok ? "success" : "critical"}>
          <s-paragraph>{data.message}</s-paragraph>
          {data.errorId ? <s-paragraph>Reference {data.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}

      <ImportForm
        heading="What your cost floors can protect"
        fetcher={fetcher}
        busy={busy}
        ready={result?.ready ?? null}
        checkLabel="Check without importing"
        commitLabel={(ready) => `Import ${formatCount(ready)} costs`}
        placeholder={"Variant SKU,Variant Cost\nCH-1,12.50\nCH-2,14.00"}
        description={
          <>
            <s-paragraph>
              <s-text>
                {withCost} of {variants} variants have a cost ({coverage}%). Cost-based
                guardrails only constrain variants that have one — the rest are skipped,
                so a low number here means &ldquo;never price below cost&rdquo; is doing
                less than it looks.
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>
                One row per variant: a SKU, barcode or variant ID, then the cost. Costs
                are read in {currency} unless a row says otherwise, and must be plain
                numbers — 12.50, not $12.50. A file exported from Matrixify works as it
                is.
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
            { label: "Written", value: result.written },
            { label: "Need attention", value: problems.length },
          ]}
          problems={problems}
          download={{
            filename: "cost-import-errors.csv",
            csv: () => costErrorCsv(result),
          }}
        />
      ) : null}
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
