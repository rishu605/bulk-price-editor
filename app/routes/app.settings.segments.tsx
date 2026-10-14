/**
 * Saved targeting, and the choice that decides what a campaign actually hits.
 *
 * The dynamic/frozen distinction is explained here rather than hidden behind a tooltip
 * because picking the wrong one does not fail — it quietly produces a different
 * campaign. A merchant who wanted "everything in Summer" and got a frozen list watches
 * new products miss the sale; one who wanted a reviewed list and got a dynamic filter
 * watches products join it unreviewed.
 */

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { actorFor } from "../lib/audit/actor";
import {
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  matchCsv,
  updateSegment,
  type SegmentEditConfirmation,
} from "../services/segments-crud.server";
import { formatCount } from "../lib/format/display";
import { facetDetails, type Facets } from "../lib/segments/facets";
import { facets } from "../services/segments.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { AppError } from "../lib/errors/app-error";
import { reportError } from "../services/error-report.server";
import { PageShell } from "../components/PageShell";
import { EmptyState } from "../components/AsyncState";
import { ActionRow } from "../components/ActionRow";
import { Field, FieldGrid, FullRow } from "../components/FieldGrid";
import { SPACE } from "../lib/ui/spacing";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { ShowingSome } from "../components/Pagination";
import { HelpNote } from "../components/HelpNote";
import { Secondary } from "../components/Type";
import { Card } from "../components/Card";
import { TableBlock } from "../components/TableBlock";
import { SegmentTable } from "../components/SegmentTable";

export const loader = withGuard("/app/settings/segments", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [segments, available] = await Promise.all([listSegments(shop.id), facets(shop.id)]);

  // The segment being edited, from `?edit=` (#742): a link rather than client state, so the
  // form survives a reload and the row's Edit is an ordinary link.
  const editId = new URL(request.url).searchParams.get("edit");
  const found = editId ? segments.find((segment) => segment.id === editId) : undefined;
  const editing = found
    ? { ...found, conditions: conditionsOf((await getSegment(shop.id, found.id)).filterAst) }
    : null;

  return { segments, facets: available, editing };
});

/** The filter form's three fields, read back out of a stored filter. */
function conditionsOf(stored: unknown): Record<"collection" | "tag" | "vendor", string> {
  const out = { collection: "", tag: "", vendor: "" };
  const groups = (stored as { groups?: Array<{ conditions?: Array<{ field: string; value: string }> }> } | null)?.groups;
  for (const condition of groups?.[0]?.conditions ?? []) {
    if (condition.field in out) out[condition.field as keyof typeof out] = condition.value;
  }
  return out;
}

/** The filter the form describes: collection, tag and vendor, each optional. */
function filterFrom(form: FormData) {
  const conditions = [
    ["collection", form.get("collection")],
    ["tag", form.get("tag")],
    ["vendor", form.get("vendor")],
  ] as const;

  return {
    groups: [
      {
        conditions: conditions
          .filter(([, value]) => value && String(value).trim())
          .map(([field, value]) => ({ field, value: String(value).trim() })),
      },
    ].filter((group) => group.conditions.length > 0),
  };
}

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
  errorId?: string | null;
  /** The form field a refusal is about, shown beside it (#741). */
  field?: string;
  /** An edit that reaches running or scheduled campaigns, waiting to be confirmed (#742). */
  confirm?: SegmentEditConfirmation;
  /** The edit was saved: the page leaves edit mode. */
  saved?: boolean;
};

export const action = withGuard("/app/settings/segments", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  // A person, not the store (#726), as on every other page that records who did something.
  const actor = actorFor(sessionToken, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "delete") {
      await deleteSegment(shop.id, String(form.get("segmentId")));
      return { ok: true, message: "Segment deleted." };
    }

    const name = String(form.get("name") ?? "");
    const kind = form.get("kind") === "FROZEN" ? "FROZEN" : "DYNAMIC";

    if (intent === "update") {
      const csv = String(form.get("csv") ?? "").trim();
      const list = csv ? await matchCsv(shop.id, csv) : null;
      if (list && list.matched.length === 0) {
        return {
          ok: false,
          field: "csv",
          message:
            "None of those rows matched a product in your catalogue, so the list was left as it is. Check the rows use SKUs, barcodes or Shopify IDs.",
        };
      }
      const segment = await updateSegment(shop.id, String(form.get("segmentId")), {
        name,
        filterAst: filterFrom(form),
        ...(list ? { variantGids: list.matched } : {}),
        pin: form.get("pin") === "1",
        acknowledgedCampaigns: form.get("acknowledged") === "1",
      });
      return { ok: true, saved: true, message: `Saved "${segment.name}".` };
    }

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
        createdBy: actor,
      });

      return {
        ok: true,
        message: `Created "${name}" with ${outcome.matched.length} of ${outcome.total} rows.`,
        report,
      };
    }

    const ast = filterFrom(form);

    const segment = await createSegment(shop.id, {
      name,
      kind,
      filterAst: ast,
      createdBy: actor,
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
    // The field a refusal is about, so the form can say it beside the control: the banner
    // sits at the top of the page and the button at the foot of the card, below the fold,
    // so a refusal shown only up there looked like a click that did nothing (#741).
    const field = error instanceof AppError && typeof error.context?.field === "string" ? error.context.field : undefined;
    const confirm =
      error instanceof AppError && error.context?.confirm ? (error.context.confirm as SegmentEditConfirmation) : undefined;
    return {
      ok: false,
      message: reported.userMessage,
      errorId: reported.errorId,
      ...(field ? { field } : {}),
      ...(confirm ? { confirm } : {}),
    };
  }
});

export default function Segments() {
  const { segments, facets: available, editing } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const navigate = useNavigate();
  useEffect(() => {
    if (result?.saved && editing) navigate("/app/settings/segments", { replace: true });
  }, [result, editing, navigate]);

  return (
    <PageShell heading="Segments">
      {result ? (
        <s-banner tone={result.ok ? "success" : "critical"}>
          <s-paragraph>{result.message}</s-paragraph>
          {result.errorId ? <s-paragraph>Reference {result.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}

      {result?.report ? <ImportReport report={result.report} /> : null}

      <Card
        heading="Your segments"
        // The ID under each name is what Flow asks for (#826), and it is a string of
        // letters nobody would recognise without being told what it is.
        secondary={
          segments.length > 0
            ? "Shopify Flow's Capture baselines for a segment action asks for a segment's ID. It is under each name, with a button that copies it."
            : undefined
        }
      >
        {segments.length === 0 ? (
          <EmptyState
            title="No segments yet"
            description="A segment is a saved way of describing which products a campaign covers, so you do not rebuild the same filter for every sale. Make one below."
          />
        ) : (
          <SegmentTable segments={segments} Form={fetcher.Form} busy={busy} />
        )}
      </Card>

      {/* Editing or creating, never both: one black button on the page at a time. */}
      {editing && !result?.saved ? (
        <EditSegment key={editing.id} segment={editing} available={available} fetcher={fetcher} busy={busy} />
      ) : (
        <NewSegment available={available} fetcher={fetcher} busy={busy} />
      )}

      <HelpNote label="Dynamic or frozen">
        <s-paragraph>
          <s-text>
            <s-badge tone="info">Dynamic</s-badge> re-checks its filter every time. A
            product you add tomorrow joins a sale already running.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            <s-badge tone="neutral">Frozen</s-badge> pins what it matches the moment you
            save it.
          </s-text>
        </s-paragraph>
        <Secondary>
          Neither is safer — they answer different questions. A dynamic segment can be
          pinned, which freezes it at what it matches now. A frozen one cannot become
          dynamic: that would widen a list you reviewed to whatever a filter returns, so
          make a new segment instead.
        </Secondary>
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
  available: Facets;
  fetcher: ReturnType<typeof useFetcher<ActionData>>;
  busy: boolean;
}) {
  const [how, setHow] = useState<"filter" | "list">("filter");
  const result = fetcher.data;

  return (
    <Card heading="New segment">  <fetcher.Form method="post">
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
              <Field width="medium">
                <s-text-field
                  name="name"
                  label="Name"
                  placeholder="Summer collection"
                  required
                  error={result && !result.ok && result.field === "name" ? result.message : undefined}
                />
              </Field>
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
                <s-select
                  name="collection"
                  label="Collection"
                  details={facetDetails(available.totals.collections, "collections")}
                >
                  <s-option value="" defaultSelected>
                    Any collection
                  </s-option>
                  {available.collections.map((c) => (
                    <s-option key={c} value={c}>
                      {c}
                    </s-option>
                  ))}
                </s-select>

                <s-select
                  name="tag"
                  label="Tag"
                  details={facetDetails(available.totals.tags, "tags")}
                >
                  <s-option value="" defaultSelected>
                    Any tag
                  </s-option>
                  {available.tags.map((t) => (
                    <s-option key={t} value={t}>
                      {t}
                    </s-option>
                  ))}
                </s-select>

                <s-select
                  name="vendor"
                  label="Vendor"
                  details={facetDetails(available.totals.vendors, "vendors")}
                >
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
    </Card>
  );
}

type Editing = NonNullable<ReturnType<typeof useLoaderData<typeof loader>>["editing"]>;

/**
 * Editing a segment (#742).
 *
 * A segment exists so that fixing it once fixes every campaign using it, and there was no
 * way to change one. Name, filter and list are editable here, and a dynamic segment can be
 * pinned. An edit that reaches a campaign pricing or about to is not saved on the first
 * press: the action answers with the campaigns and the segment's size before and after,
 * and the same form, pressed again, confirms it.
 */
function EditSegment({
  segment,
  available,
  fetcher,
  busy,
}: {
  segment: Editing;
  available: Facets;
  fetcher: ReturnType<typeof useFetcher<ActionData>>;
  busy: boolean;
}) {
  const result = fetcher.data;
  const confirm = result && !result.ok ? result.confirm : undefined;
  const dynamic = segment.kind === "DYNAMIC";

  /** A facet's options, with the segment's own value kept even if it is no longer listed. */
  const optionsFor = (current: string, values: readonly string[]) =>
    (current && !values.includes(current) ? [current, ...values] : values).map((value) => (
      <s-option key={value} value={value} defaultSelected={value === current}>
        {value}
      </s-option>
    ));
  const { collection, tag, vendor } = segment.conditions;

  return (
    <Card heading={`Edit “${segment.name}”`}>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="update" />
        <input type="hidden" name="segmentId" value={segment.id} />
        {confirm ? <input type="hidden" name="acknowledged" value="1" /> : null}

        <s-stack gap={SPACE.section}>
          {confirm ? (
            <s-banner tone="warning">
              <s-paragraph>
                <s-text>
                  {confirm.campaigns.map((campaign) => `“${campaign.name}” (${campaign.status.toLowerCase()})`).join(", ")}{" "}
                  {confirm.campaigns.length === 1 ? "uses" : "use"} this segment. Saving changes what{" "}
                  {confirm.campaigns.length === 1 ? "it prices" : "they price"}: {formatCount(confirm.before)} variants
                  now, {formatCount(confirm.after)} after this edit.
                </s-text>
              </s-paragraph>
            </s-banner>
          ) : null}

          <FieldGrid>
            <FullRow>
              <Field width="medium">
                <s-text-field
                  name="name"
                  label="Name"
                  value={segment.name}
                  required
                  error={result && !result.ok && result.field === "name" ? result.message : undefined}
                />
              </Field>
            </FullRow>

            {dynamic ? (
              <>
                <s-select name="collection" label="Collection" details={facetDetails(available.totals.collections, "collections")}>
                  <s-option value="" defaultSelected={!collection}>
                    Any collection
                  </s-option>
                  {optionsFor(collection, available.collections)}
                </s-select>
                <s-select name="tag" label="Tag" details={facetDetails(available.totals.tags, "tags")}>
                  <s-option value="" defaultSelected={!tag}>
                    Any tag
                  </s-option>
                  {optionsFor(tag, available.tags)}
                </s-select>
                <s-select name="vendor" label="Vendor" details={facetDetails(available.totals.vendors, "vendors")}>
                  <s-option value="" defaultSelected={!vendor}>
                    Any vendor
                  </s-option>
                  {optionsFor(vendor, available.vendors)}
                </s-select>
                <FullRow>
                  <s-checkbox
                    name="pin"
                    value="1"
                    label="Pin it to the products it matches now"
                    details="Makes it frozen. A product added later will not join a campaign using it. This cannot be undone."
                  />
                </FullRow>
              </>
            ) : (
              <FullRow>
                <s-text-area
                  name="csv"
                  label="Replace the list (optional)"
                  rows={6}
                  placeholder={"SKU-1\nSKU-2"}
                  details={`It pins ${formatCount(segment.size)} variants now. Leave this empty to keep them; paste SKUs, barcodes or IDs to replace them.`}
                  error={result && !result.ok && result.field === "csv" ? result.message : undefined}
                />
              </FullRow>
            )}
          </FieldGrid>

          <ActionRow>
            <s-button type="submit" variant="primary" loading={busy || undefined}>
              {confirm ? "Save anyway" : "Save changes"}
            </s-button>
            <s-button href="/app/settings/segments">Cancel</s-button>
          </ActionRow>
        </s-stack>
      </fetcher.Form>
    </Card>
  );
}

function ImportReport({ report }: { report: NonNullable<ActionData["report"]> }) {
  const clean =
    report.unmatched.length === 0 && report.ambiguous.length === 0 && report.repeated === 0;

  return (
    <Card heading="What the list matched">  <s-paragraph>
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
                    <TableBlock
            pagination={<ShowingSome
            shown={Math.min(report.ambiguous.length, ROWS_PER_VIEW)}
            total={report.ambiguous.length}
            noun="rows"
          />}
          >
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
          </TableBlock>
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
                    <TableBlock
            pagination={<ShowingSome
            shown={Math.min(report.unmatched.length, ROWS_PER_VIEW)}
            total={report.unmatched.length}
            noun="rows"
          />}
          >
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
          </TableBlock>
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
    </Card>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
