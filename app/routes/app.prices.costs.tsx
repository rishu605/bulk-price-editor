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
import { facets, type FilterAst } from "../services/segments.server";
import { actorFor } from "../lib/audit/actor";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";

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

type ActionData = { ok: boolean; message: string; result?: CostEditResult };

export const action = withGuard("/app/prices/costs", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const currency = await shopCurrency(shop.id);
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

  const dryRun = String(form.get("intent")) !== "commit";
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
  const { currency, withCost, variants, vendors, violations, violationCount } =
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

      <s-section heading="What your cost floors can protect">
        <s-paragraph>
          <s-text>
            {withCost} of {variants} variants have a cost ({coverage}%). Cost-based
            guardrails skip the rest entirely, so a low number here means &ldquo;never
            price below cost&rdquo; is doing less than it looks.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-link href="/app/imports/costs">Import costs from a spreadsheet</s-link>
        </s-paragraph>
      </s-section>

      <s-section heading="Change costs in bulk">
        {fetcher.data ? (
          <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        <fetcher.Form method="post" ref={form}>
          {/* `s-button` takes no name/value, so the intent rides in a hidden field the
              buttons set before submitting. One form, because both actions read the same
              rule and duplicating the fields would let them drift apart. */}
          <input type="hidden" name="intent" ref={intent} value="dry-run" readOnly />
          <s-stack gap="base">
            <s-select name="vendor" label="Which products">
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

            <s-number-field
              name="value"
              label={`Amount (percent, or ${currency})`}
              value="4"
              details="Products with no cost are skipped by the first two rules rather than treated as zero."
            />

            <s-stack direction="inline" gap="base">
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
            </s-stack>
          </s-stack>
        </fetcher.Form>

        {fetcher.data?.result && fetcher.data.result.skipped.length > 0 ? (
          <s-unordered-list>
            {fetcher.data.result.skipped.slice(0, 10).map((entry) => (
              <s-list-item key={entry.variantGid}>{entry.reason}</s-list-item>
            ))}
          </s-unordered-list>
        ) : null}
      </s-section>
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
