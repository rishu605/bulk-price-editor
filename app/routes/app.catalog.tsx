import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { formatMoney, money } from "../lib/money/money";
import { FilterForm } from "../components/FilterForm";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";

const PAGE_SIZE = 50;

export const loader = withGuard("/app/catalog", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const where = {
    shopId: shop.id,
    deletedAt: null,
    ...(query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" as const } },
            { sku: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, variants] = await Promise.all([
    prisma.variantIndex.count({ where }),
    prisma.variantIndex.findMany({
      where,
      orderBy: [{ title: "asc" }, { variantGid: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const baselines = await prisma.baseline.findMany({
    where: {
      shopId: shop.id,
      supersededAt: null,
      surfaceKind: "BASE",
      variantGid: { in: variants.map((v) => v.variantGid) },
    },
    select: { variantGid: true, basePrice: true, capturedAt: true, source: true },
  });

  const baselineByVariant = new Map(baselines.map((b) => [b.variantGid, b]));

  const rows = variants.map((variant) => {
    const baseline = baselineByVariant.get(variant.variantGid);
    const currency = variant.currency ?? "USD";
    const fmt = (value: bigint | null | undefined) =>
      value === null || value === undefined
        ? null
        : formatMoney(money(Number(value), currency));

    return {
      variantGid: variant.variantGid,
      title: variant.title ?? variant.variantGid,
      sku: variant.sku,
      currency,
      price: fmt(variant.price),
      compareAt: fmt(variant.compareAt),
      cost: fmt(variant.cost),
      baseline: fmt(baseline?.basePrice),
      baselineSource: baseline?.source ?? null,
      // Live differing from baseline is expected during a campaign and a warning
      // sign outside one -- the badge says which, the dashboard explains why.
      atBaseline:
        baseline !== undefined &&
        variant.price !== null &&
        baseline.basePrice === variant.price,
    };
  });

  return { rows, total, page, query, pageSize: PAGE_SIZE };
});

export default function Catalog() {
  const { rows, total, page, query, pageSize } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  const goTo = (next: number) =>
    setSearchParams((params) => {
      params.set("page", String(next));
      return params;
    });

  return (
    <s-page heading="Catalogue">
      <s-section>
        <FilterForm fields={["q"]}>
          <s-stack direction="inline" gap="base">
            <s-text-field
              name="q"
              label="Search"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by title or SKU"
              value={query}
            />
            <s-button type="submit">Search</s-button>
          </s-stack>
        </FilterForm>

        {total === 0 ? (
          <s-paragraph>
            {query
              ? `No variants match “${query}”.`
              : "No variants yet. Sync your catalogue from the dashboard."}
          </s-paragraph>
        ) : (
          <>
            <s-paragraph>
              <s-text>
                Showing {from}–{to} of {total} variants
              </s-text>
            </s-paragraph>

            <s-table>
              <s-table-header-row>
                <s-table-header>Variant</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Live price</s-table-header>
                <s-table-header>Baseline</s-table-header>
                <s-table-header>Compare at</s-table-header>
                <s-table-header>Cost</s-table-header>
                <s-table-header>State</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => (
                  <s-table-row key={row.variantGid}>
                    <s-table-cell>{row.title}</s-table-cell>
                    <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                    <s-table-cell>{row.price ?? "—"}</s-table-cell>
                    <s-table-cell>{row.baseline ?? "—"}</s-table-cell>
                    <s-table-cell>{row.compareAt ?? "—"}</s-table-cell>
                    <s-table-cell>{row.cost ?? "—"}</s-table-cell>
                    <s-table-cell>
                      {row.baseline === null ? (
                        <s-badge tone="warning">No baseline</s-badge>
                      ) : row.atBaseline ? (
                        <s-badge tone="success">At baseline</s-badge>
                      ) : (
                        <s-badge tone="info">Not at baseline</s-badge>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

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

      <s-section slot="aside" heading="What these mean">
        <s-paragraph>
          <strong>Live price</strong> is what your storefront shows right now.
        </s-paragraph>
        <s-paragraph>
          <strong>Baseline</strong> is the reference price every campaign computes
          from. It only changes when you recapture, so a discount is always measured
          against your real price rather than a previous discount.
        </s-paragraph>
        <s-paragraph>
          <s-text>
            &ldquo;Not at baseline&rdquo; is expected while a campaign is running.
            Outside one, it means something changed the price elsewhere.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
