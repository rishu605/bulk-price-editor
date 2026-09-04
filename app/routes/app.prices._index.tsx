import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { shopCurrency } from "../services/settings.server";
import { Blank } from "../components/Blank";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { formatMoney, money } from "../lib/money/money";
import { EmptyState, NoMatches } from "../components/AsyncState";
import { clearedSearch } from "../components/FilterForm";
import { VariantSearch } from "../components/prices/VariantSearch";
import { Pagination } from "../components/Pagination";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { HelpNote } from "../components/HelpNote";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { Secondary } from "../components/Type";
import { TableBlock } from "../components/TableBlock";

const PAGE_SIZE = ROWS_PER_VIEW;

/** What the search box on this tab owns, and therefore what Clear filters removes. */
const CATALOGUE_FIELDS = ["q"] as const;

export const loader = withGuard("/app/prices", async ({ request }: LoaderFunctionArgs) => {
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

  // Named once under the table rather than in four column headers. Every amount here is
  // the base surface in the shop's own currency, and "Live price (USD) · Baseline (USD) ·
  // Compare at (USD) · Cost (USD)" spends four headings saying one thing.
  return { rows, total, page, query, pageSize: PAGE_SIZE, currency: await shopCurrency(shop.id) };
});

export default function Catalog() {
  const { rows, total, page, query, pageSize, currency } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  return (
    /* "Variants", the same word as the tab that opens this page.

        It was headed "Catalogue" while its tab said "Variants" and the nav item above
        both said "Prices" — three words for one place, read in that order. The tab bar is
        the set this belongs to (Variants · Baselines · Costs · What's live · Drift), and
        every other name in it is the column it lists. This one lists variants.

        "Catalogue" stays in the prose, where it means the mirror of the shop rather than
        this page: syncing the catalogue is what fills this table. */
    <PageShell heading="Variants">
      <s-section>
        <VariantSearch fields={CATALOGUE_FIELDS} query={query} />

        {total === 0 ? (
          query ? (
            <NoMatches
              noun="variants"
              description={`Nothing in your catalogue has “${query}” in its title or SKU.`}
              clearHref={clearedSearch(params, CATALOGUE_FIELDS)}
            />
          ) : (
            <EmptyState
              title="No variants yet"
              description="Anchor mirrors your catalogue so a campaign can be priced without asking Shopify for every variant first. Syncing captures a baseline for each one at the same time."
              action={{ label: "Sync your catalogue", href: "/app" }}
            />
          )
        ) : (
          <>
                        <TableBlock
              caption={
<Secondary>
              Amounts are your store&rsquo;s base price, in {currency}.
            </Secondary>
              }
              pagination={<Pagination page={page} total={total} pageSize={pageSize} />}
            >
<s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Variant</s-table-header>
                <s-table-header listSlot="secondary">SKU</s-table-header>
                <s-table-header listSlot="labeled" format="currency">Live price</s-table-header>
                <s-table-header listSlot="labeled" format="currency">Baseline</s-table-header>
                <s-table-header listSlot="labeled" format="currency">Compare at</s-table-header>
                <s-table-header listSlot="labeled" format="currency">Cost</s-table-header>
                <s-table-header listSlot="inline">State</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => (
                  <s-table-row key={row.variantGid}>
                    <s-table-cell>{row.title}</s-table-cell>
                    <s-table-cell>{row.sku ?? <Blank />}</s-table-cell>
                    {/* Not emphasised on the rows that moved, though it was worth trying.
                    
                        `<s-text type="strong">` inside an `s-table-cell` renders at
                        exactly the weight of the cell beside it — checked on the deployed
                        page at 4x zoom, where the drifted 538.04 and the untouched 750.03
                        below it are indistinguishable. Polaris gives a table one type
                        weight and means it, and nothing in this app had tried to argue
                        with that before.
                    
                        Which is fine: the state column is the signal, and it is now the
                        only coloured thing on the row. A price that had to be bold to be
                        found would mean the state column was not doing its job. */}
                    <s-table-cell>{row.price ?? <Blank />}</s-table-cell>
                    <s-table-cell>{row.baseline ?? <Blank />}</s-table-cell>
                    <s-table-cell>{row.compareAt ?? <Blank />}</s-table-cell>
                    <s-table-cell>{row.cost ?? <Blank />}</s-table-cell>
                    {/* Only the exceptions carry a colour.
                    
                        "At baseline" was a green badge, and on a healthy catalogue that is
                        every row: a screenful of success badges, each one drawing the eye
                        to a variant that needs nothing, and the one row that had moved
                        competing with forty that had not. Colour spent on the normal case
                        is colour that carries no information.
                    
                        Subdued text rather than a neutral badge, because a badge is a
                        shape as well as a colour — forty grey pills read as forty things
                        to look at. `colour-signal.test.ts` still holds: each state says
                        its own name, so nothing here is carried by colour alone. */}
                    <s-table-cell>
                      {row.baseline === null ? (
                        <s-badge tone="warning">No baseline</s-badge>
                      ) : row.atBaseline ? (
                        <s-text color="subdued">At baseline</s-text>
                      ) : (
                        <s-badge tone="info">Not at baseline</s-badge>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            </TableBlock>
          </>
        )}
      </s-section>

      <HelpNote label="What these mean">
        <s-paragraph>
          <strong>Live price</strong> — what your storefront shows now.
        </s-paragraph>
        <s-paragraph>
          <strong>Baseline</strong> — the reference every campaign computes from. It
          changes only when you recapture, so a discount is never measured against a
          previous discount.
        </s-paragraph>
        <s-paragraph>
          <strong>Not at baseline</strong> — expected while a campaign runs. Outside one,
          something else changed the price.
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
