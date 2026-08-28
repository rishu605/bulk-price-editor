/**
 * Saved targeting, and the choice that decides what a campaign actually hits.
 *
 * The dynamic/frozen distinction is explained here rather than hidden behind a tooltip
 * because picking the wrong one does not fail — it quietly produces a different
 * campaign. A merchant who wanted "everything in Summer" and got a frozen list watches
 * new products miss the sale; one who wanted a reviewed list and got a dynamic filter
 * watches products join it unreviewed.
 */

import { useState } from "react";
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
import { PageShell } from "../components/PageShell";
import { EmptyState } from "../components/AsyncState";
import { ActionRow } from "../components/ActionRow";
import { FieldGrid, FullRow } from "../components/FieldGrid";
import { SPACE } from "../lib/ui/spacing";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { ShowingSome } from "../components/Pagination";
import { HelpNote } from "../components/HelpNote";

export const loader = withGuard("/app/settings/segments", async ({ request }: LoaderFunctionArgs) => {
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

export const action = withGuard("/app/settings/segments", async ({ request }: ActionFunctionArgs) => {
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
      route: "/app/settings/segments",
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
    <PageShell heading="Segments">
      {result ? (
        <s-banner tone={result.ok ? "success" : "critical"}>
          <s-paragraph>{result.message}</s-paragraph>
          {result.errorId ? <s-paragraph>Reference {result.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}

      {result?.report ? <ImportReport report={result.report} /> : null}

      <s-section heading="Your segments">
        {segments.length === 0 ? (
          <EmptyState
            title="No segments yet"
            description="A segment is a saved way of describing which products a campaign covers, so you do not rebuild the same filter for every sale. Make one below."
          />
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header listSlot="inline">Kind</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">Products</s-table-header>
              <s-table-header listSlot="secondary">Used by</s-table-header>
              <s-table-header listSlot="inline">Action</s-table-header>
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

      <NewSegment available={available} fetcher={fetcher} busy={busy} />

      <HelpNote label="Dynamic or frozen">
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
      </HelpNote>
    </PageShell>
  );
}

/**
 * Making a segment, as one decision instead of two cards.
 *
 * There were two sibling sections — "New segment from a filter" and "New segment from a
 * list" — each ending in its own black `variant="primary"` button. A merchant reading
 * down the page met two equally loud answers to "make a segment" and had to read both
 * cards to discover they differ only in *how the products are named*. Two black buttons
 * is the failure `ActionRow` names, spread across two cards so that neither card broke
 * the rule on its own.
 *
 * One card, one name field, and a choice. `s-choice-list` is what a choice between two
 * mutually exclusive things is — one of the components the epic noted the app had never
 * used, and this is the case it is for.
 *
 * ## Why the behaviour select disappears for a list
 *
 * A pasted list of SKUs is always frozen: naming specific products *is* pinning them, and
 * there is no filter left to re-check. The old CSV card knew that and said so in a
 * sentence; showing a Dynamic/Frozen select that only applies to one branch would offer a
 * choice that is not there.
 */
function NewSegment({
  available,
  fetcher,
  busy,
}: {
  available: { collections: string[]; tags: string[]; vendors: string[] };
  fetcher: ReturnType<typeof useFetcher<ActionData>>;
  busy: boolean;
}) {
  const [how, setHow] = useState<"filter" | "list">("filter");

  return (
    <s-section heading="New segment">
      <fetcher.Form method="post">
        {/* The two branches were two intents on two forms. One form, and the intent
            follows the choice — so the name field cannot be filled in on one card and
            submitted from the other. */}
        <input
          type="hidden"
          name="intent"
          value={how === "filter" ? "create-filter" : "create-from-csv"}
        />

        <s-stack gap={SPACE.section}>
          <FieldGrid>
            <FullRow>
              <s-text-field name="name" label="Name" placeholder="Summer collection" required />
            </FullRow>

            <FullRow>
              {/* Uncontrolled, like every other field in this app: `defaultSelected` on
                  the choice, and the state here only decides which fields to render
                  underneath. Driving the selection from React state as well would put two
                  owners on one value, and `docs/polaris-notes.md` records what happens
                  when a Polaris component's own value handling is fought — it wins
                  quietly. */}
              <s-choice-list
                name="how"
                label="Which products"
                onChange={(event) =>
                  setHow(event.currentTarget.values?.includes("list") ? "list" : "filter")
                }
              >
                {/* The supporting line is a slot, not a prop. `s-choice` is one of the
                    components whose React types `Omit` their `details`, because it is
                    `ComponentChildren` rather than a string — passing it as an attribute
                    compiles nowhere and renders nothing. */}
                <s-choice value="filter" defaultSelected>
                  Everything matching a filter
                  <s-text slot="details" color="subdued">
                    Collection, tag or vendor.
                  </s-text>
                </s-choice>
                <s-choice value="list">
                  A list of products I name
                  <s-text slot="details" color="subdued">
                    SKUs, barcodes or Shopify IDs you paste. Always frozen — you are
                    naming specific products, so the list is pinned to exactly those.
                  </s-text>
                </s-choice>
              </s-choice-list>
            </FullRow>

            {how === "filter" ? (
              <>
                <s-select name="collection" label="Collection">
                  <s-option value="" defaultSelected>
                    Any collection
                  </s-option>
                  {available.collections.map((c) => (
                    <s-option key={c} value={c}>
                      {c}
                    </s-option>
                  ))}
                </s-select>

                <s-select name="tag" label="Tag">
                  <s-option value="" defaultSelected>
                    Any tag
                  </s-option>
                  {available.tags.map((t) => (
                    <s-option key={t} value={t}>
                      {t}
                    </s-option>
                  ))}
                </s-select>

                <s-select name="vendor" label="Vendor">
                  <s-option value="" defaultSelected>
                    Any vendor
                  </s-option>
                  {available.vendors.map((v) => (
                    <s-option key={v} value={v}>
                      {v}
                    </s-option>
                  ))}
                </s-select>

                <s-select name="kind" label="How it should behave">
                  <s-option value="DYNAMIC" defaultSelected>
                    Dynamic &mdash; re-check the filter every time
                  </s-option>
                  <s-option value="FROZEN">
                    Frozen &mdash; pin the products it matches right now
                  </s-option>
                </s-select>
              </>
            ) : (
              <FullRow>
                <s-text-area
                  name="csv"
                  label="SKUs, barcodes or IDs"
                  rows={8}
                  placeholder={"SKU-1\nSKU-2\n9781234567897"}
                  details="One per line, or the first column of a CSV. Anything we cannot match is reported rather than skipped."
                />
              </FullRow>
            )}
          </FieldGrid>

          <ActionRow>
            <s-button type="submit" variant="primary" loading={busy || undefined}>
              Create segment
            </s-button>
          </ActionRow>
        </s-stack>
      </fetcher.Form>
    </s-section>
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
              <s-table-header listSlot="kicker" format="numeric">Line</s-table-header>
              <s-table-header listSlot="primary">Value</s-table-header>
              <s-table-header listSlot="inline">Matches</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {report.ambiguous.slice(0, ROWS_PER_VIEW).map((row) => (
                <s-table-row key={`${row.line}-${row.value}`}>
                  <s-table-cell>{row.line}</s-table-cell>
                  <s-table-cell>{row.value}</s-table-cell>
                  <s-table-cell>{row.candidates} products</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <ShowingSome
            shown={Math.min(report.ambiguous.length, ROWS_PER_VIEW)}
            total={report.ambiguous.length}
            noun="rows"
          />
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
              <s-table-header listSlot="kicker" format="numeric">Line</s-table-header>
              <s-table-header listSlot="primary">Value</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {report.unmatched.slice(0, ROWS_PER_VIEW).map((row) => (
                <s-table-row key={`${row.line}-${row.value}`}>
                  <s-table-cell>{row.line}</s-table-cell>
                  <s-table-cell>{row.value}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <ShowingSome
            shown={Math.min(report.unmatched.length, ROWS_PER_VIEW)}
            total={report.unmatched.length}
            noun="rows"
          />
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
