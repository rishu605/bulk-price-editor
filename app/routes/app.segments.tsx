/**
 * Saved targeting, and the choice that decides what a campaign actually hits.
 *
 * The dynamic/frozen distinction is explained here rather than hidden behind a tooltip
 * because picking the wrong one does not fail — it quietly produces a different
 * campaign. A merchant who wanted "everything in Summer" and got a frozen list watches
 * new products miss the sale; one who wanted a reviewed list and got a dynamic filter
 * watches products join it unreviewed.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import {
  createSegment,
  deleteSegment,
  listSegments,
  matchCsv,
} from "../services/segments-crud.server";
import { facets } from "../services/segments.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { reportError } from "../services/error-report.server";

export const loader = withGuard("/app/segments", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [segments, available] = await Promise.all([listSegments(shop.id), facets(shop.id)]);
  return { segments, facets: available };
});

type ActionData = {
  ok: boolean;
  message: string;
  /** Rows the upload could not place. Shown, never guessed at. */
  report?: {
    total: number;
    matched: number;
    unmatched: Array<{ line: number; value: string }>;
    ambiguous: Array<{ line: number; value: string; candidates: number }>;
    repeated: number;
  };
  errorId?: string;
};

export const action = withGuard("/app/segments", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "delete") {
      await deleteSegment(shop.id, String(form.get("segmentId")));
      return { ok: true, message: "Segment deleted." };
    }

    const name = String(form.get("name") ?? "");
    const kind = form.get("kind") === "FROZEN" ? "FROZEN" : "DYNAMIC";

    if (intent === "create-from-csv") {
      const csv = String(form.get("csv") ?? "");
      const outcome = await matchCsv(shop.id, csv);

      // The report comes back whether or not anything is created. A merchant who
      // uploads 3,000 rows and gets a segment of 2,960 with no explanation has a
      // campaign that quietly misses 40 products.
      const report = {
        total: outcome.total,
        matched: outcome.matched.length,
        unmatched: outcome.unmatched,
        ambiguous: outcome.ambiguous.map((a) => ({
          line: a.row.line,
          value: a.row.value,
          candidates: a.candidates.length,
        })),
        repeated: outcome.repeated.length,
      };

      if (outcome.matched.length === 0) {
        return {
          ok: false,
          message:
            "None of those rows matched a product in your catalogue. Check the file uses SKUs, barcodes or Shopify IDs.",
          report,
        };
      }

      await createSegment(shop.id, {
        name,
        kind: "FROZEN",
        variantGids: outcome.matched,
        createdBy: session.shop,
      });

      return {
        ok: true,
        message: `Created "${name}" with ${outcome.matched.length} of ${outcome.total} rows.`,
        report,
      };
    }

    const conditions = [
      ["collection", form.get("collection")],
      ["tag", form.get("tag")],
      ["vendor", form.get("vendor")],
    ] as const;

    const ast = {
      groups: [
        {
          conditions: conditions
            .filter(([, value]) => value && String(value).trim())
            .map(([field, value]) => ({ field, value: String(value).trim() })),
        },
      ].filter((group) => group.conditions.length > 0),
    };

    const segment = await createSegment(shop.id, {
      name,
      kind,
      filterAst: ast,
      createdBy: session.shop,
    });

    return {
      ok: true,
      message:
        kind === "FROZEN"
          ? `Created "${segment.name}" and pinned ${segment.frozenVariantGids.length} variants.`
          : `Created "${segment.name}". It re-checks the filter every time a campaign uses it.`,
    };
  } catch (error) {
    const reported = await reportError(error, {
      shopId: shop.id,
      shop: session.shop,
      route: "/app/segments",
      context: { intent },
    });
    return { ok: false, message: reported.userMessage, errorId: reported.errorId };
  }
});

export default function Segments() {
  const { segments, facets: available } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Segments">
      {result ? (
        <s-banner tone={result.ok ? "success" : "critical"}>
          <s-paragraph>{result.message}</s-paragraph>
          {result.errorId ? <s-paragraph>Reference {result.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}

      {result?.report ? <ImportReport report={result.report} /> : null}

      <s-section heading="Your segments">
        {segments.length === 0 ? (
          <s-paragraph>
            No segments yet. A segment is a saved way of describing which products a
            campaign covers, so you do not rebuild the same filter for every sale.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Kind</s-table-header>
              <s-table-header>Products</s-table-header>
              <s-table-header>Used by</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {segments.map((segment) => (
                <s-table-row key={segment.id}>
                  <s-table-cell>{segment.name}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={segment.kind === "DYNAMIC" ? "info" : "neutral"}>
                      {segment.kind === "DYNAMIC" ? "Dynamic" : "Frozen"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{segment.size}</s-table-cell>
                  <s-table-cell>
                    {segment.usedBy.length === 0
                      ? "—"
                      : segment.usedBy.map((c) => c.name).join(", ")}
                  </s-table-cell>
                  <s-table-cell>
                    {segment.usedBy.length > 0 ? (
                      // Not a disabled button: a control that does nothing invites
                      // clicking it repeatedly. The reason is the answer.
                      <s-text>In use — remove from campaigns first</s-text>
                    ) : (
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="segmentId" value={segment.id} />
                        <s-button type="submit" tone="critical" variant="tertiary" loading={busy || undefined}>
                          Delete
                        </s-button>
                      </fetcher.Form>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="New segment from a filter">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create-filter" />
          <s-stack gap="base">
            <s-text-field name="name" label="Name" placeholder="Summer collection" required />

            <label htmlFor="collection">Collection</label>
            <select id="collection" name="collection" defaultValue="">
              <option value="">Any collection</option>
              {available.collections.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <label htmlFor="tag">Tag</label>
            <select id="tag" name="tag" defaultValue="">
              <option value="">Any tag</option>
              {available.tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>

            <label htmlFor="vendor">Vendor</label>
            <select id="vendor" name="vendor" defaultValue="">
              <option value="">Any vendor</option>
              {available.vendors.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>

            <label htmlFor="kind">How it should behave</label>
            <select id="kind" name="kind" defaultValue="DYNAMIC">
              <option value="DYNAMIC">Dynamic — re-check the filter every time</option>
              <option value="FROZEN">Frozen — pin the products it matches right now</option>
            </select>

            <s-button type="submit" variant="primary" loading={busy || undefined}>
              Create segment
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="New segment from a list">
        <s-paragraph>
          <s-text>
            Paste SKUs, barcodes or Shopify IDs — one per line, or the first column of a
            CSV. This always makes a frozen segment: you are naming specific products,
            so the list is pinned to exactly those.
          </s-text>
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create-from-csv" />
          <s-stack gap="base">
            <s-text-field name="name" label="Name" placeholder="Clearance list" required />
            <s-text-area name="csv" label="SKUs, barcodes or IDs" rows={8} />
            <s-button type="submit" variant="primary" loading={busy || undefined}>
              Match and create
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="Dynamic or frozen">
        <s-paragraph>
          <s-text>
            <s-badge tone="info">Dynamic</s-badge> re-checks its filter every time a
            campaign uses it. A product you add to the collection tomorrow joins a sale
            that is already running.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            <s-badge tone="neutral">Frozen</s-badge> pins the products it matches the
            moment you save it. A campaign hits exactly the list you reviewed, and
            nothing that appears later.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            Neither is safer than the other — they answer different questions. You
            cannot switch a segment between the two afterwards, because doing so would
            change what a running campaign prices without you asking it to. Make a new
            one instead.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function ImportReport({ report }: { report: NonNullable<ActionData["report"]> }) {
  const clean =
    report.unmatched.length === 0 && report.ambiguous.length === 0 && report.repeated === 0;

  return (
    <s-section heading="What the list matched">
      <s-paragraph>
        <s-text>
          {report.matched} of {report.total} rows matched a product.
          {clean ? " Every row was placed." : ""}
        </s-text>
      </s-paragraph>

      {report.ambiguous.length > 0 ? (
        <>
          <s-banner tone="warning">
            <s-paragraph>
              {report.ambiguous.length} row{report.ambiguous.length === 1 ? "" : "s"} matched
              more than one product, so {report.ambiguous.length === 1 ? "it was" : "they were"}{" "}
              left out. Picking one for you could put the wrong product on sale.
            </s-paragraph>
          </s-banner>
          <s-table>
            <s-table-header-row>
              <s-table-header>Line</s-table-header>
              <s-table-header>Value</s-table-header>
              <s-table-header>Matches</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {report.ambiguous.slice(0, 50).map((row) => (
                <s-table-row key={`${row.line}-${row.value}`}>
                  <s-table-cell>{row.line}</s-table-cell>
                  <s-table-cell>{row.value}</s-table-cell>
                  <s-table-cell>{row.candidates} products</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </>
      ) : null}

      {report.unmatched.length > 0 ? (
        <>
          <s-paragraph>
            <s-text>
              {report.unmatched.length} row{report.unmatched.length === 1 ? "" : "s"} matched
              nothing in your catalogue:
            </s-text>
          </s-paragraph>
          <s-table>
            <s-table-header-row>
              <s-table-header>Line</s-table-header>
              <s-table-header>Value</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {report.unmatched.slice(0, 50).map((row) => (
                <s-table-row key={`${row.line}-${row.value}`}>
                  <s-table-cell>{row.line}</s-table-cell>
                  <s-table-cell>{row.value}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </>
      ) : null}

      {report.repeated > 0 ? (
        <s-paragraph>
          <s-text>
            {report.repeated} row{report.repeated === 1 ? " was" : "s were"} listed more than
            once and counted once.
          </s-text>
        </s-paragraph>
      ) : null}
    </s-section>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
