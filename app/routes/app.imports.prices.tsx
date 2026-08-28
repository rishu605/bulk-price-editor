/**
 * Importing exact prices.
 *
 * The file does not set prices — it creates a campaign that does. That is not ceremony:
 * it is what gives an import a preview, guardrails, rounding, market surfaces and a
 * revert, all of which a direct write would have had none of, on the one path where a
 * merchant most needs them.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRef } from "react";
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
import { UnsavedChanges } from "../components/UnsavedChanges";
import { CsvDropZone } from "../components/imports/CsvDropZone";

export const loader = withGuard("/app/imports/prices", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  return { currency: await shopCurrency(shop.id) };
});

type ActionData = { ok: boolean; message: string; result?: PriceImportResult };

export const action = withGuard("/app/imports/prices", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const currency = await shopCurrency(shop.id);
  const dryRun = String(form.get("intent")) !== "commit";
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
  const { currency } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data?.result;

  const form = useRef<HTMLFormElement>(null);
  const intent = useRef<HTMLInputElement>(null);

  const submitWith = (value: string) => {
    if (intent.current) intent.current.value = value;
    form.current?.requestSubmit();
  };

  const problems = result
    ? [...result.invalid, ...result.unmatched, ...result.ambiguous, ...result.duplicates]
    : [];

  return (
    <PageShell heading="Import prices">
      {/* A pasted CSV can be fifty thousand rows, and none of it exists anywhere until
          the import runs. */}
      <UnsavedChanges
        form={form}
        describe="this import"
        saved={Boolean(fetcher.data)}
      />
      {fetcher.data ? (
        <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Set prices from a spreadsheet">
        <s-paragraph>
          <s-text>
            This creates a campaign rather than changing prices straight away. You get a
            preview of every product first, your guardrails still apply, and you can undo
            the whole thing in one click &mdash; none of which a direct import would give
            you.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            One row per variant: a SKU, barcode or variant ID, then the price. Prices are
            read in {currency} and must be plain numbers. A Matrixify export works as it
            is.
          </s-text>
        </s-paragraph>

        <fetcher.Form method="post" ref={form}>
          <input type="hidden" name="intent" ref={intent} value="dry-run" readOnly />
          <s-stack gap="base">
            <s-text-field name="name" label="Call this" value="Imported prices" />
            <CsvDropZone target="csv" />

            <s-text-area
              name="csv"
              label="Rows"
              rows={12}
              placeholder={"Variant SKU,Variant Price\nCH-1,129.00\nCH-2,149.00"}
              details="Paste straight from a spreadsheet."
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
                loading={busy || undefined}
                onClick={() => submitWith("commit")}
              >
                Create a campaign from it
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {problems.length > 0 ? (
        <s-section heading="Rows that need fixing">
          <s-unordered-list>
            {problems.slice(0, 25).map((problem) => (
              <s-list-item key={`${problem.line}-${problem.identifier}`}>
                Line {problem.line} ({problem.identifier || "no identifier"}): {problem.reason}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      ) : null}
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
