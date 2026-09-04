/**
 * Editing costs in bulk, and the warning that follows.
 *
 * The editor is straightforward. The banner above it is the point: a cost change can put
 * a campaign that is already running below its own floor, and nothing about the storefront
 * changes to say so. No run fails, nothing alerts, and the merchant loses money on every
 * sale until somebody notices.
 *
 * We report it and stop there. Repricing a live campaign because a cost moved would be the
 * app changing prices on its own initiative — the one thing it must never do — and a
 * merchant may well decide to honour the sale and take the margin hit.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { shopCurrency } from "../services/settings.server";
import { editCosts, newlyViolating, type CostEditResult } from "../services/cost-edit.server";
import { describeCostRule, type CostRule } from "../lib/pricing/cost-rules";
import { money } from "../lib/money/money";
import { format } from "../lib/money/format";
import { facetDetails } from "../lib/segments/facets";
import { facets, type FilterAst } from "../services/segments.server";
import { actorFor } from "../lib/audit/actor";
import { ActionRow } from "../components/ActionRow";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { FieldGrid, FullRow } from "../components/FieldGrid";
import { ImportForm, ImportReport, type ImportProblem } from "../components/imports/ImportForm";
import { importCosts, type CostImportResult } from "../services/cost-import.server";
import { costErrorCsv } from "../lib/reporting/cost-errors";
import { linesOf } from "../lib/reporting/lines";
import { isCommit } from "../lib/imports/intent";
import { reportError } from "../services/error-report.server";
import { SPACE } from "../lib/ui/spacing";
import { Card } from "../components/Card";

export const loader = withGuard("/app/prices/costs", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [available, currency, withCost, variants, violations] = await Promise.all([
    facets(shop.id),
    shopCurrency(shop.id),
    prisma.variantIndex.count({ where: { shopId: shop.id, cost: { not: null }, deletedAt: null } }),
    prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } }),
    newlyViolating(shop.id),
  ]);

  return {
    currency,
    withCost,
    variants,
    vendors: available.vendors,
    vendorTotal: available.totals.vendors,
    violations: violations.slice(0, 25).map((violation) => ({
      campaignId: violation.campaignId,
      campaignName: violation.campaignName,
      title: violation.title,
      live: format(violation.live),
      floor: format(violation.floor),
    })),
    violationCount: violations.length,
  };
});

type ActionData = {
  ok: boolean;
  message: string;
  result?: CostEditResult;
  imported?: CostImportResult;
  errorId?: string;
};

/**
 * The two things a merchant can do to costs in bulk, on one route.
 *
 * Importing costs was `/app/imports/costs` — a tab called "Costs" in a nav section named
 * after a verb, beside a tab called "Costs" in Prices. Two right answers to "where do I
 * set costs", which is the collision that made Imports worth dissolving.
 *
 * They share a route, so they cannot share an `intent`. The import's pair is namespaced
 * and dispatched first; the bulk editor keeps the bare pair it always had. Both read it
 * through `isCommit`, so the property that matters — a missing or misspelled intent
 * writes nothing — is one function with a test rather than two string comparisons.
 */
export const IMPORT_INTENT = { check: "import-dry-run", commit: "import-commit" } as const;

export const action = withGuard("/app/prices/costs", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const currency = await shopCurrency(shop.id);
  const intent = form.get("intent");

  if (intent === IMPORT_INTENT.check || intent === IMPORT_INTENT.commit) {
    try {
      const imported = await importCosts(
        shop.id,
        linesOf(String(form.get("csv") ?? "")),
        currency,
        {
          dryRun: !isCommit(intent, IMPORT_INTENT.commit),
          actor: actorFor(sessionToken, session.shop),
        },
      );

      return {
        ok: true,
        imported,
        message: imported.dryRun
          ? `${imported.ready} of ${imported.total} rows would be imported. Nothing has been written.`
          : `Imported ${imported.written} costs.` +
            (imported.unchanged > 0
              ? ` ${imported.unchanged} already matched and were left alone.`
              : ""),
      };
    } catch (error) {
      const reported = await reportError(error, {
        shopId: shop.id,
        shop: session.shop,
        route: "/app/prices/costs",
      });
      return { ok: false, message: reported.userMessage, errorId: reported.errorId };
    }
  }

  const amount = Number(form.get("value") ?? 0);
  const kind = String(form.get("ruleKind") ?? "percent-change");

  const rule: CostRule =
    kind === "set-exact"
      ? { kind: "set-exact", amount: money(Math.round(amount * 100), currency) }
      : kind === "fixed-change"
        ? { kind: "fixed-change", amount: money(Math.round(amount * 100), currency) }
        : kind === "share-of-price"
          ? { kind: "share-of-price", percent: amount }
          : { kind: "percent-change", percent: amount };

  const vendor = String(form.get("vendor") ?? "").trim();
  const ast: FilterAst = vendor ? { groups: [{ conditions: [{ field: "vendor", value: vendor }] }] } : { groups: [] };

  const dryRun = !isCommit(intent);
  const result = await editCosts(shop.id, ast, rule, {
    dryRun,
    actor: actorFor(sessionToken, session.shop),
  });

  return {
    ok: true,
    result,
    message: dryRun
      ? `${describeCostRule(rule)}: ${result.changed} of ${result.matched} would change. Nothing has been written.`
      : `${result.changed} costs updated.`,
  };
});

export default function Costs() {
  const { currency, withCost, variants, vendors, vendorTotal, violations, violationCount } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";

  const form = useRef<HTMLFormElement>(null);
  const intent = useRef<HTMLInputElement>(null);

  const submitWith = (value: string) => {
    if (intent.current) intent.current.value = value;
    form.current?.requestSubmit();
  };

  const coverage = variants === 0 ? 0 : Math.round((withCost / variants) * 100);
  const imported = fetcher.data?.imported;

  const problems: ImportProblem[] = imported
    ? [
        ...imported.invalid.map((problem) => ({ ...problem, kind: "Will not parse" })),
        ...imported.unmatched.map((problem) => ({ ...problem, kind: "No match" })),
        ...imported.ambiguous.map((problem) => ({ ...problem, kind: "Matches several" })),
      ].sort((a, b) => a.line - b.line)
    : [];

  return (
    <PageShell heading="Costs">
      {violationCount > 0 ? (
        <s-banner tone="critical">
          <s-heading>A cost change has put live prices below your floor</s-heading>
          <s-paragraph>
            {violationCount} {violationCount === 1 ? "product is" : "products are"} selling
            below what your guardrails allow. Nothing on your storefront changed — the cost
            did, and these prices were set before it.
          </s-paragraph>
          <s-unordered-list>
            {violations.map((violation) => (
              <s-list-item key={`${violation.campaignId}-${violation.title}`}>
                {violation.title} — selling at {violation.live}, floor is {violation.floor} (
                {violation.campaignName})
              </s-list-item>
            ))}
          </s-unordered-list>
          <s-paragraph>
            <s-text>
              Re-preview the campaign to reprice these, or leave them if you would rather
              honour the sale. We will not change them on our own.
            </s-text>
          </s-paragraph>
        </s-banner>
      ) : null}


      <Card heading="What your cost floors can protect">    <s-paragraph>
          <s-text>
            {withCost} of {variants} variants have a cost ({coverage}%). Cost-based
            guardrails skip the rest entirely, so a low number here means &ldquo;never
            price below cost&rdquo; is doing less than it looks.
          </s-text>
        </s-paragraph>
      </Card>

      <Card heading="Change costs in bulk">    {fetcher.data ? (
          <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        <fetcher.Form method="post" ref={form}>
          {/* `s-button` takes no name/value, so the intent rides in a hidden field the
              buttons set before submitting. One form, because both actions read the same
              rule and duplicating the fields would let them drift apart. */}
          <input type="hidden" name="intent" ref={intent} value="dry-run" readOnly />
          {/* A grid, not a stack.

              Stacked, each of these took the full width of the card: a "Which products"
              select holding the words "Every product" rendered nine hundred and seventy
              pixels wide, and so did a two-digit percentage. `FieldGrid`'s own doc
              comment calls that "the single most unstyled-looking thing in this app" —
              and this page was one of the four still doing it. */}
          <s-stack gap={SPACE.section}>
            <FieldGrid>
            <s-select
              name="vendor"
              label="Which products"
              details={facetDetails(vendorTotal, "vendors")}
            >
              <s-option value="" defaultSelected>
                Every product
              </s-option>
              {vendors.map((vendor) => (
                <s-option key={vendor} value={vendor}>
                  {vendor}
                </s-option>
              ))}
            </s-select>

            <s-select name="ruleKind" label="Change">
              <s-option value="percent-change" defaultSelected>
                Adjust the existing cost by a percentage
              </s-option>
              <s-option value="fixed-change">Add or subtract a fixed amount</s-option>
              <s-option value="set-exact">Set an exact cost</s-option>
              <s-option value="share-of-price">
                Set cost to a percentage of the normal price
              </s-option>
            </s-select>

            <FullRow>
              <s-number-field
                name="value"
                label={`Amount (percent, or ${currency})`}
                value="4"
                details="Products with no cost are skipped by the first two rules rather than treated as zero."
              />
            </FullRow>
            </FieldGrid>

            <ActionRow>
              <s-button
                type="button"
                variant="primary"
                loading={busy || undefined}
                onClick={() => submitWith("dry-run")}
              >
                Check without changing
              </s-button>
              <s-button
                type="button"
                tone="critical"
                loading={busy || undefined}
                onClick={() => submitWith("commit")}
              >
                Change these costs
              </s-button>
            </ActionRow>
          </s-stack>
        </fetcher.Form>

        {fetcher.data?.result && fetcher.data.result.skipped.length > 0 ? (
          <s-unordered-list>
            {fetcher.data.result.skipped.slice(0, 10).map((entry) => (
              <s-list-item key={entry.variantGid}>{entry.reason}</s-list-item>
            ))}
          </s-unordered-list>
        ) : null}
      </Card>
      <ImportForm
        heading="Import costs from a spreadsheet"
        fetcher={fetcher}
        busy={busy}
        intent={IMPORT_INTENT}
        ready={imported?.ready ?? null}
        checkLabel="Check the file"
        commitLabel={(ready) => `Import ${ready} costs`}
        placeholder={"Variant SKU,Variant Cost\nCH-1,12.50\nCH-2,14.00"}
        description={
          <s-paragraph>
            <s-text>
              One row per variant: a SKU, barcode or variant ID, then the cost. Costs are
              read in {currency} unless a row says otherwise, and must be plain numbers —
              12.50, not $12.50. A file exported from Matrixify works as it is.
            </s-text>
          </s-paragraph>
        }
      />

      {imported ? (
        <ImportReport
          heading={imported.dryRun ? "What would happen" : "What the file did"}
          counts={[
            { label: "Rows read", value: imported.total },
            { label: "Ready", value: imported.ready },
            { label: "Written", value: imported.written },
            { label: "Need attention", value: problems.length },
          ]}
          problems={problems}
          download={{
            filename: "cost-import-errors.csv",
            csv: () => costErrorCsv(imported),
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
