/**
 * A campaign made from a spreadsheet.
 *
 * This lived at `/app/imports/prices` under a nav item of its own, and the first line of
 * its own doc comment said why that was wrong: **the file does not set prices — it
 * creates a campaign that does.** That is not ceremony. It is what gives an import a
 * preview, guardrails, rounding, market surfaces and a revert, all of which a direct
 * write would have had none of, on the one path where a merchant most needs them.
 *
 * A flow whose entire output is a campaign belongs with campaigns. Filed under "Imports"
 * it read as a fourth kind of import beside baselines and costs, which are genuinely
 * different things — they write reference data, this one starts a sale.
 *
 * The list of files a shop has imported comes with it, for the same reason: a campaign
 * can price *from* an import, so "which file is this campaign reading?" is a question
 * about campaigns. `price_imports` had recorded every one since the feature shipped and
 * nothing displayed them until #351; that page's whole content is below the form now.
 *
 * Baselines and costs record no import row. A real gap rather than an omission here, and
 * still said out loud rather than papered over.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { shopCurrency } from "../services/settings.server";
import {
  importedVariantGids,
  importPrices,
  type PriceImportResult,
} from "../services/price-import.server";
import { createCampaign } from "../services/campaigns/index.server";
import { linesOf } from "../lib/reporting/lines";
import { actorFor } from "../lib/audit/actor";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import prisma from "../db.server";
import { PageShell } from "../components/PageShell";
import { formatCount, formatWhen } from "../lib/format/display";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { EmptyState } from "../components/AsyncState";
import { HelpNote } from "../components/HelpNote";
import { isCommit } from "../lib/imports/intent";
import {
  ImportForm,
  ImportReport,
  type ImportProblem,
} from "../components/imports/ImportForm";

export const loader = withGuard("/app/campaigns/import", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const imports = await prisma.priceImport.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: ROWS_PER_VIEW,
    select: {
      id: true,
      name: true,
      currency: true,
      rowsRead: true,
      rowsMatched: true,
      createdBy: true,
      createdAt: true,
    },
  });

  return {
    currency: await shopCurrency(shop.id),
    timeZone: shop.timezone,
    imports: imports.map((row) => ({
      ...row,
      // `formatWhen`, not a second call to toLocaleString: the locale is centralised
      // there, and a page that picks its own drifts from every other page's dates.
      createdAt: formatWhen(row.createdAt, shop.timezone),
    })),
  };
});

type ActionData = { ok: boolean; message: string; result?: PriceImportResult };

export const action = withGuard("/app/campaigns/import", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const currency = await shopCurrency(shop.id);
  const dryRun = !isCommit(form.get("intent"));
  const name = String(form.get("name") ?? "Imported prices").trim() || "Imported prices";
  const actor = actorFor(sessionToken, session.shop);

  const result = await importPrices(
    shop.id,
    name,
    linesOf(String(form.get("csv") ?? "")),
    currency,
    { dryRun, actor },
  );

  if (dryRun || !result.importId) {
    return {
      ok: true,
      result,
      message: `${result.ready} of ${result.total} rows matched a product. Nothing has been created yet.`,
    };
  }

  // Frozen to exactly the variants the file named. A dynamic filter would let products
  // added later fall into a campaign whose rule can say nothing about them.
  const gids = await importedVariantGids(result.importId);
  const segment = await prisma.segment.create({
    data: {
      shopId: shop.id,
      name: `${name} (imported)`,
      kind: "FROZEN",
      filterAst: { groups: [] } as never,
      frozenVariantGids: gids,
    },
  });

  const campaign = await createCampaign(shop.id, {
    name,
    ast: { groups: [] },
    segmentId: segment.id,
    rule: { kind: "from-import", importId: result.importId },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
  });

  // Straight to the preview. The whole argument for routing an import through a campaign
  // is that the merchant sees what it will do before it does it.
  return redirect(`/app/campaigns/${campaign.id}`);
});

export default function ImportPrices() {
  const { currency, imports, timeZone } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data?.result;

  const problems: ImportProblem[] = result
    ? [
        ...result.invalid.map((p) => ({ ...p, kind: "Will not parse" })),
        ...result.unmatched.map((p) => ({ ...p, kind: "No match" })),
        ...result.ambiguous.map((p) => ({ ...p, kind: "Matches several" })),
        ...result.duplicates.map((p) => ({ ...p, kind: "Listed twice" })),
      ].sort((a, b) => a.line - b.line)
    : [];

  return (
    <PageShell heading="Import prices" backTo={{ href: "/app/campaigns", label: "Campaigns" }}>
      {fetcher.data ? (
        <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <ImportForm
        heading="Set prices from a spreadsheet"
        fetcher={fetcher}
        busy={busy}
        ready={result?.ready ?? null}
        commitLabel={(ready) => `Create a campaign from ${formatCount(ready)} rows`}
        placeholder={"Variant SKU,Variant Price\nCH-1,129.00\nCH-2,149.00"}
        description={
          <>
            <s-paragraph>
              <s-text>
                This creates a campaign rather than changing prices straight away. You get
                a preview of every product first, your guardrails still apply, and you can
                undo the whole thing in one click &mdash; none of which a direct import
                would give you.
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>
                One row per variant: a SKU, barcode or variant ID, then the price. Prices
                are read in {currency} and must be plain numbers. A Matrixify export works
                as it is.
              </s-text>
            </s-paragraph>
          </>
        }
      >
        <s-text-field name="name" label="Call this" value="Imported prices" />
      </ImportForm>

      <s-section heading="Price files you have imported">
        {imports.length === 0 ? (
          <EmptyState
            title="Nothing imported yet"
            description="Every file you import is recorded here with its row counts and who ran it, so you can always answer which file a campaign is pricing from."
          />
        ) : (
          <>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="kicker">Imported</s-table-header>
                <s-table-header listSlot="primary">File</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Rows read</s-table-header>
                <s-table-header listSlot="secondary" format="numeric">
                  Matched a variant
                </s-table-header>
                <s-table-header listSlot="labeled">By</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {imports.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>{row.createdAt}</s-table-cell>
                    <s-table-cell>
                      {row.name} <s-text color="subdued">({row.currency})</s-text>
                    </s-table-cell>
                    <s-table-cell>{formatCount(row.rowsRead)}</s-table-cell>
                    <s-table-cell>
                      {/* The gap between these two is the number worth reading: rows
                          that named a variant this shop does not have. */}
                      {formatCount(row.rowsMatched)}
                      {row.rowsMatched < row.rowsRead ? (
                        <s-text tone="caution">
                          {" "}
                          · {formatCount(row.rowsRead - row.rowsMatched)} matched nothing
                        </s-text>
                      ) : null}
                    </s-table-cell>
                    <s-table-cell>{row.createdBy ?? "—"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-paragraph>
              <s-text color="subdued">Times are your store&rsquo;s, in {timeZone}.</s-text>
            </s-paragraph>
          </>
        )}
      </s-section>

      <HelpNote label="Only price files are listed">
        <s-paragraph>
          Baseline and cost imports do not record a file yet. Their results are shown when
          you run them, on the pages they belong to.
        </s-paragraph>
      </HelpNote>

      {result ? (
        <ImportReport
          heading={result.dryRun ? "What would happen" : "What happened"}
          counts={[
            { label: "Rows read", value: result.total },
            { label: "Ready", value: result.ready },
            { label: "Need attention", value: problems.length },
          ]}
          problems={problems}
        />
      ) : null}
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
