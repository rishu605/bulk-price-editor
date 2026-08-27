import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { PageShell } from "../components/PageShell";
import { formatCount, formatWhen } from "../lib/format/display";
import prisma from "../db.server";

/**
 * What has been imported, and when.
 *
 * `price_imports` has recorded every price file a shop has ever imported — the name, the
 * row counts, who ran it — and nothing has ever displayed one. A campaign can price from
 * an import, so "which file is this campaign reading?" was a question the app held the
 * answer to and would not give.
 *
 * This is also what makes `/app/imports` a page rather than a redirect. It used to bounce
 * straight to the prices form, which meant the section had no landing place and the tab
 * bar was the only thing telling a merchant the other sources existed.
 *
 * Baselines and costs do not record an import row. That is a real gap rather than an
 * omission here, and it is called out on the page instead of being papered over.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const imports = await prisma.priceImport.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 25,
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
    imports: imports.map((row) => ({
      ...row,
      // `formatWhen`, not a second call to toLocaleString: the locale is centralised
      // there, and a page that picks its own drifts from every other page's dates.
      createdAt: formatWhen(row.createdAt, shop.timezone),
    })),
    timeZone: shop.timezone,
  };
};

export default function Imports() {
  const { imports, timeZone } = useLoaderData<typeof loader>();

  return (
    <PageShell heading="Imports">
      <s-section heading="Price files you have imported">
        {imports.length === 0 ? (
          <s-paragraph>
            <s-text>
              Nothing imported yet. Pick a source above — a price file sets prices
              directly, a baseline file sets the reference every campaign computes from,
              and a cost file feeds the margin guardrails.
            </s-text>
          </s-paragraph>
        ) : (
          <>
            <s-table>
              <s-table-header-row>
                <s-table-header>File</s-table-header>
                <s-table-header>Imported</s-table-header>
                <s-table-header>Rows read</s-table-header>
                <s-table-header>Matched a variant</s-table-header>
                <s-table-header>By</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {imports.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>
                      {row.name} <s-text tone="neutral">({row.currency})</s-text>
                    </s-table-cell>
                    <s-table-cell>{row.createdAt}</s-table-cell>
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
              <s-text tone="neutral">Times are your store&rsquo;s, in {timeZone}.</s-text>
            </s-paragraph>
          </>
        )}
      </s-section>

      <s-section slot="aside" heading="Only price files are listed">
        <s-paragraph>
          Baseline and cost imports do not record a file yet, so they do not appear here.
          Their results are shown when you run them.
        </s-paragraph>
      </s-section>
    </PageShell>
  );
}
