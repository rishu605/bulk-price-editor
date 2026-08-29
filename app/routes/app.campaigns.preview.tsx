/**
 * The whole preview, not the first twenty-five.
 *
 * The editor's preview lives beside the rule now, and a sidebar cannot be a list of three
 * thousand rows — so the escape hatch has to exist somewhere. NA has `Full Preview` under
 * its inline preview for the same reason. Without it "showing the first 25" is a promise
 * a merchant has to take on trust, on the one screen whose entire job is not asking them
 * to.
 *
 * ## The same `resolve()`, not a second one
 *
 * `previewDraft` with a larger limit, from the same `draftCampaignFrom` reading of the
 * same fields. Rule 4 says preview and execution share one code path; a full preview that
 * reached the rows a different way would be a third opinion, and the first one to
 * disagree would be believed because it is the longer list.
 *
 * ## Why the draft travels in the URL
 *
 * The campaign does not exist yet — that is the whole point of previewing it — so there
 * is nothing to link to by id. The editor serialises its form into the query string,
 * which also means the page can be reloaded, bookmarked mid-decision, or opened in a
 * second tab beside the form it came from. Nothing here writes.
 */

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Blank } from "../components/Blank";
import { MoneyCell } from "../components/MoneyCell";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { draftCampaignFrom } from "../services/campaigns/draft-input.server";
import { previewDraft } from "../services/campaigns/draft-preview.server";
import { shopCurrency } from "../services/settings.server";
import { PageShell } from "../components/PageShell";
import { RouteBoundary } from "../components/RouteBoundary";
import { ActionRow } from "../components/ActionRow";
import { EmptyState } from "../components/AsyncState";
import { HelpNote } from "../components/HelpNote";
import { withGuard } from "../lib/errors/guard.server";
import { formatCount } from "../lib/format/display";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { SPACE } from "../lib/ui/spacing";

export const loader = withGuard("/app/campaigns/preview", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const params = new URL(request.url).searchParams;
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);

  const draft = await draftCampaignFrom(shop.id, params, await shopCurrency(shop.id));

  // Ask for everything up to the end of this page and show the tail. `previewDraft` takes
  // a limit rather than an offset because the resolver plans the whole scope either way —
  // the limit only decides how many rows get a product title looked up, which is the part
  // that costs a query.
  const preview = await previewDraft(shop.id, draft, page * ROWS_PER_VIEW);
  const rows = preview.rows.slice((page - 1) * ROWS_PER_VIEW);

  const total = preview.changing + preview.alreadyCorrect + preview.skipped;

  return {
    rows,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / ROWS_PER_VIEW)),
    counts: {
      changing: preview.changing,
      alreadyCorrect: preview.alreadyCorrect,
      skipped: preview.skipped,
      matched: preview.matched,
    },
  };
});

export default function FullPreview() {
  const { rows, total, page, pages, counts } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  const pageHref = (next: number) => {
    const q = new URLSearchParams(params);
    q.set("page", String(next));
    return `?${q}`;
  };

  return (
    <PageShell
      heading="Full preview"
      backTo={{ href: `/app/campaigns/new?${params}`, label: "Back to the campaign" }}
    >
      <s-section>
        <s-stack gap={SPACE.section}>
          <s-paragraph>
            <s-text>
              {formatCount(counts.changing)} of {formatCount(counts.matched)} variants
              would change. {formatCount(counts.alreadyCorrect)} are already at this price
              and {formatCount(counts.skipped)} would be skipped.
            </s-text>
          </s-paragraph>

          {rows.length === 0 ? (
            <EmptyState
              title="Nothing matches this scope"
              description="No variant matches every condition on this campaign. Loosen one, or leave them all blank to target the whole catalogue."
            />
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Variant</s-table-header>
                {/* Baseline, not the live price — the distinction is the product. See
                    `DraftPreviewRow.before`. */}
                <s-table-header listSlot="labeled" format="currency">
                  Baseline
                </s-table-header>
                <s-table-header listSlot="inline" format="currency">
                  Becomes
                </s-table-header>
                <s-table-header listSlot="labeled" format="currency">
                  On the storefront now
                </s-table-header>
                <s-table-header listSlot="labeled">Note</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => (
                  <s-table-row key={row.variantGid}>
                    <s-table-cell>{row.title}</s-table-cell>
                    {/* The same pair the editor's panel shows, rendered the same way.
                        This page is where its "See all N rows" button goes, and it used
                        to drop both compare-ats — so a merchant who followed that button
                        to check a sale arrived at a table with the strike-through
                        missing, and the fuller view said less than the summary it came
                        from. */}
                    <s-table-cell>
                      <MoneyCell amount={row.before} compareAt={row.beforeCompareAt} />
                    </s-table-cell>
                    <s-table-cell>
                      <MoneyCell amount={row.after} compareAt={row.afterCompareAt} />
                    </s-table-cell>
                    {/* Only when it disagrees with the baseline, which is when it means
                        something. `live` is null in the ordinary case. */}
                    <s-table-cell>
                      <MoneyCell amount={row.live} />
                    </s-table-cell>
                    <s-table-cell>
                      {row.skippedReason ?? (row.unchanged ? "Already at this price" : <Blank />)}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          {pages > 1 ? (
            <ActionRow>
              {page > 1 ? (
                <s-button icon="chevron-left" href={pageHref(page - 1)}>
                  Previous
                </s-button>
              ) : null}
              <s-text color="subdued" fontVariantNumeric="tabular-nums">
                Page {page} of {pages} · {formatCount(total)} rows
              </s-text>
              {page < pages ? (
                <s-button icon="chevron-right" href={pageHref(page + 1)}>
                  Next
                </s-button>
              ) : null}
            </ActionRow>
          ) : null}
        </s-stack>
      </s-section>

      <HelpNote label="What this is">
        <s-paragraph>
          The same calculation the run will perform, on the same code path — not an
          estimate. Nothing here has been written to your storefront.
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
