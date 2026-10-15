import type { ComponentProps } from "react";
import { Blank } from "../components/Blank";
import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  FetcherWithComponents,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { actorFor } from "../lib/audit/actor";
import { toAdminClient } from "../services/admin-client.server";
import { reassertDrift } from "../services/campaigns/reassert.server";
import { driftTitle, resolveDrift, type DriftResolution, type DriftRow } from "../services/drift.server";
import { batchStatus, decideDrift, driftQueue } from "../services/drift-queue.server";
import {
  batchParamFrom,
  describeBatch,
  describeDriftFilters,
  describeProgress,
  DRIFT_CHOICES,
  DRIFT_FILTER_FIELDS,
  driftFiltersFrom,
  isFiltered,
  type DriftChoice,
} from "../lib/drift/batch";
import { RouteBoundary } from "../components/RouteBoundary";
import { focusAfterRemoval } from "../lib/ui/focus-after-removal";
import { choiceName } from "../lib/drift/choice-name";
import { withGuard } from "../lib/errors/guard.server";
import { AppError } from "../lib/errors/app-error";
import { PageShell } from "../components/PageShell";
import { EmptyState, NoMatches } from "../components/AsyncState";
import { ActionRow } from "../components/ActionRow";
import { Pagination } from "../components/Pagination";
import { HelpNote } from "../components/HelpNote";
import { Secondary } from "../components/Type";
import { TableBlock } from "../components/TableBlock";
import { ExportButton } from "../components/ExportButton";
import { clearedSearch } from "../components/FilterForm";
import { VariantSearch } from "../components/prices/VariantSearch";
import { DriftBulkActions, DriftBulkConfirmations, useFollowBatch, type BulkTarget } from "../components/drift/DriftBulk";
import { exportQuery } from "../lib/reporting/export-filters";
import { formatCount } from "../lib/format/display";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { SPACE } from "../lib/ui/spacing";

/**
 * The filter form's fields, and `batch`: a filter changed while the page follows a decision
 * stops following it, because the decision was over the old filters.
 */
const FILTER_FIELDS = [...DRIFT_FILTER_FIELDS, "batch"] as const;

export const loader = withGuard("/app/prices/drift", async ({ request }: LoaderFunctionArgs) => {
  // Before anything is read: a decision made from this page covers the edits it showed,
  // and an edit that lands while it loads is not one of them (#822).
  const asOf = new Date().toISOString();
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const url = new URL(request.url);
  const filters = driftFiltersFrom(url.searchParams);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  // The true total and the filtered count, both: a queue that shows fifteen of forty and
  // says nothing reads as forty resolved decisions when it is fifteen.
  const queue = await driftQueue(shop.id, filters, page);
  const following = batchParamFrom(url.searchParams.get("batch"));
  const status = following ? await batchStatus(shop.id, following, filters) : null;

  return { ...queue, filters, page, asOf, status };
});

export const action = withGuard("/app/prices/drift", async ({ request }: ActionFunctionArgs) => {
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  // The staff member who decided, not the store (#726): "who kept this drifted price as
  // the new baseline?" is the question the activity log exists to answer.
  const actor = actorFor(sessionToken, session.shop);

  const form = await request.formData();

  // One decision over everything the filters match (#822). The filters come back with it,
  // and the page's load time, so it covers exactly what the merchant was shown.
  if (form.get("intent") === "bulk") {
    const resolution = String(form.get("resolution"));
    const filters = driftFiltersFrom(new URLSearchParams([...form.entries()].map(([key, value]) => [key, String(value)])));
    const asOf = new Date(String(form.get("asOf")));
    if (!DRIFT_CHOICES.includes(resolution as DriftChoice) || !filters.campaignId || Number.isNaN(asOf.getTime())) {
      return { ok: false, message: "That decision arrived incomplete, so nothing was changed. Reload the page and choose again." };
    }
    return decideDrift(
      shop.id,
      { campaignId: filters.campaignId, resolution: resolution as DriftChoice, q: filters.q, direction: filters.direction, asOf: asOf.toISOString() },
      actor,
      toAdminClient(admin),
    );
  }

  const eventId = String(form.get("eventId"));
  const resolution = String(form.get("resolution")) as DriftResolution;

  try {
    // Putting the price back is a write, so it is a run, made now -- not a mark waiting
    // for a run that a manual or held campaign never gets (#756).
    if (resolution === "reassert") {
      return await reassertDrift(shop.id, eventId, toAdminClient(admin), actor);
    }

    const title = await driftTitle(shop.id, eventId);
    const { released } = await resolveDrift(shop.id, eventId, resolution, actor);
    // Named (#796): which price the decision was about, and a different sentence for each.
    const which = title ? `"${title}"` : "That price";
    const wording: Record<typeof resolution, string> = {
      adopt: `${which} is the new baseline. Future campaigns compute from this price.`,
      ignore: `${which} is left as the merchant set it, for now.`,
    };
    return {
      ok: true,
      message: wording[resolution] + (released ? " Nothing else was waiting, so the campaign is running again." : ""),
    };
  } catch (error) {
    // A refusal the merchant can act on -- the price to keep is gone (#755) -- is said on
    // this page, beside the row, rather than replacing the queue with an error screen.
    if (error instanceof AppError && error.code === "VALIDATION") {
      return { ok: false, message: error.userMessage };
    }
    throw error;
  }
});

type ActionData = { ok: boolean; message: string; batch?: string };

export default function DriftQueue() {
  const { rows, total, filtered, campaigns, bulk, matchingCampaigns, filters, page, asOf, status } =
    useLoaderData<typeof loader>();
  const [params, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";

  // After a decision removes its row, focus goes to the row that took its place, or to the
  // count line when none are left -- not to the page body (#796).
  const table = useRef<HTMLElement | null>(null);
  const countLineRef = useRef<HTMLElement | null>(null);
  const outcomeRef = useRef<HTMLElement | null>(null);
  const decided = useRef<number | null>(null);
  useEffect(() => {
    if (decided.current === null || fetcher.state !== "idle") return;
    focusAfterRemoval(table.current, decided.current, countLineRef.current ?? outcomeRef.current);
    decided.current = null;
  }, [rows, fetcher.state]);

  // A decision the worker has: the page follows it through its URL, so a reload keeps
  // following, and asks again every few seconds until it is done.
  const handedOff = fetcher.data?.batch;
  useEffect(() => {
    if (!handedOff) return;
    setSearchParams((next) => {
      next.set("batch", handedOff);
      return next;
    });
  }, [handedOff, setSearchParams]);
  useFollowBatch(Boolean(status && !status.done));

  const target: BulkTarget | null = bulk
    ? {
        campaign: bulk,
        count: filtered,
        waiting: campaigns.find((campaign) => campaign.id === bulk.id)?.pending ?? filtered,
        filters: describeDriftFilters(filters),
      }
    : null;
  const decide = (resolution: DriftChoice) =>
    target &&
    fetcher.submit(
      {
        intent: "bulk",
        resolution,
        campaign: target.campaign.id,
        q: filters.q ?? "",
        direction: filters.direction ?? "",
        asOf,
      },
      { method: "post" },
    );

  return (
    <PageShell heading="Price drift">
      {status ? (
        <s-banner tone={status.done ? (status.done.stopped || status.done.notConfirmed ? "warning" : "success") : "info"}>
          <s-paragraph>
            {status.done ? describeBatch(status.done) : describeProgress(status.ref, status.campaign, status.progress)}
          </s-paragraph>
        </s-banner>
      ) : fetcher.data && !handedOff ? (
        <s-banner
          tone={fetcher.data.ok ? "success" : "critical"}
          ref={(element) => {
            // Where focus lands when the last row is gone (#796): the sentence saying what
            // the decision did, rather than the page body.
            element?.setAttribute("tabindex", "-1");
            outcomeRef.current = element;
          }}
        >
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section>
        {total === 0 ? (
          // The one empty state in the app that is good news. It says so, rather than
          // reading as a page that failed to load.
          <EmptyState
            title="No drift detected"
            description="Every price your campaigns set is still what they set. If somebody edits one in the Shopify admin while a campaign is running, it is held here for your decision rather than overwritten."
          />
        ) : (
          <s-stack direction="block" gap={SPACE.section}>
            <s-paragraph>
              These prices changed outside Anchor while a campaign was running. Someone
              did that deliberately, so nothing has been overwritten — choose what
              should happen to each, or to all of them at once.
            </s-paragraph>

            <VariantSearch
              fields={FILTER_FIELDS}
              query={filters.q ?? ""}
              label="Product title, SKU or variant ID"
              direction="block"
            >
              <s-select name="campaign" label="Campaign">
                <s-option value="" defaultSelected={!filters.campaignId}>
                  Every campaign
                </s-option>
                {campaigns.map((campaign) => (
                  <s-option key={campaign.id} value={campaign.id} defaultSelected={filters.campaignId === campaign.id}>
                    {`${campaign.name} (${formatCount(campaign.pending)})`}
                  </s-option>
                ))}
              </s-select>
              <s-select name="direction" label="Direction">
                <s-option value="" defaultSelected={!filters.direction}>
                  Raised or lowered
                </s-option>
                <s-option value="up" defaultSelected={filters.direction === "up"}>
                  Raised above the campaign&rsquo;s price
                </s-option>
                <s-option value="down" defaultSelected={filters.direction === "down"}>
                  Lowered below the campaign&rsquo;s price
                </s-option>
              </s-select>
            </VariantSearch>

            {filtered === 0 ? (
              <NoMatches
                noun="drifted prices"
                description={`${formatCount(total)} drifted ${total === 1 ? "price is" : "prices are"} waiting in all. Clear the filters to see ${total === 1 ? "it" : "them"}.`}
                clearHref={clearedSearch(params, FILTER_FIELDS)}
              />
            ) : (
              <>
                {/* The count and the export on one line, because the count is exactly what
                    the export holds and what a decision below covers. */}
                <ActionRow>
                  <s-text
                    fontVariantNumeric="tabular-nums"
                    ref={(element) => {
                      // Focusable by script only, as the place focus lands when no row is left.
                      element?.setAttribute("tabindex", "-1");
                      countLineRef.current = element;
                    }}
                  >
                    {countLine(filtered, total, isFiltered(filters))}
                  </s-text>
                  <ExportButton
                    href={`/app/export/drift${exportQuery(params)}`}
                    filename="anchor-price-drift.csv"
                    rows={filtered}
                    noun={["drifted price", "drifted prices"]}
                  />
                </ActionRow>

                <DriftBulkActions target={target} campaigns={matchingCampaigns} busy={busy} />

                <TableBlock
                  pagination={<Pagination page={page} total={filtered} pageSize={ROWS_PER_VIEW} noun="drifted prices" />}
                >
                  <s-table
                    ref={(element) => {
                      table.current = element;
                    }}
                  >
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Variant</s-table-header>
                      <s-table-header listSlot="labeled" format="currency">Campaign set</s-table-header>
                      <s-table-header listSlot="labeled" format="currency">Now shows</s-table-header>
                      <s-table-header listSlot="secondary">Campaign</s-table-header>
                      <s-table-header listSlot="inline">Resolve</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {rows.map((event, index) => (
                        <DriftDecision
                          key={event.id}
                          event={event}
                          fetcher={fetcher}
                          busy={busy}
                          onDecide={() => (decided.current = index)}
                        />
                      ))}
                    </s-table-body>
                  </s-table>
                </TableBlock>
              </>
            )}
          </s-stack>
        )}
      </s-section>

      {target && target.count > 0 ? <DriftBulkConfirmations target={target} busy={busy} onConfirm={decide} /> : null}

      <HelpNote label="What the three choices do">
        <s-paragraph>
          <strong>Keep the change</strong> — make the new price the baseline. For a
          permanent repricing.
        </s-paragraph>
        <s-paragraph>
          <strong>Put it back</strong> — write the campaign&rsquo;s price again now, and read
          it back. For a mistake.
        </s-paragraph>
        <s-paragraph>
          <strong>Leave it for now</strong> — close the alert, change nothing.
        </s-paragraph>
        <Secondary>
          Only the first changes what future campaigns compute from, which is why it is
          the one marked consequential. A campaign held by edits runs again once every one
          of them is resolved. Filter to one campaign to decide all of its prices at once.
        </Secondary>
      </HelpNote>
    </PageShell>
  );
}

/** "1,113 drifted prices waiting", or "40 of 1,113 match these filters": never just the page. */
function countLine(filtered: number, total: number, narrowed: boolean): string {
  const noun = total === 1 ? "drifted price" : "drifted prices";
  return narrowed
    ? `${formatCount(filtered)} of ${formatCount(total)} ${noun} match these filters`
    : `${formatCount(total)} ${noun} waiting for a decision`;
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/**
 * The three decisions, in the words the help centre already uses for them.
 *
 * They were rendered straight out of the enum — `adopt` `reassert` `ignore`, lower case,
 * on the page whose entire job is a considered choice about somebody's storefront.
 * `docs/help/concepts/drift.md` has had merchant wording for two of them since before
 * this page existed; the page and the documentation of the page had never been read next
 * to each other.
 *
 * `tone` is doing real work in the third field rather than decorating. The aside says
 * only one of the three changes what future campaigns compute from, and until now the
 * page rendered all three identically while the panel beside it explained that one of
 * them was different. It is the same treatment Revert carries on a campaign, which is
 * also less destruction than a decision worth being sure about.
 */
const RESOLUTIONS = [
  { value: "adopt", label: "Keep the change", tone: "critical" },
  { value: "reassert", label: "Put it back", tone: "auto" },
  { value: "ignore", label: "Leave it for now", tone: "auto" },
] as const satisfies readonly {
  value: DriftResolution;
  label: string;
  tone: ComponentProps<"s-button">["tone"];
}[];

/**
 * One drifted price, and the choice about it.
 *
 * Named for the decision rather than the row, so it does not collide with the
 * `DriftRow` the service returns — one is what we know, the other is what to do.
 *
 * Its own component so that the row can own a ref. `s-button` takes no `name` or `value`,
 * so the app's pattern for a form with several submits is a hidden field the buttons set
 * before submitting — which needs a ref, and a ref created inside a `.map()` is a new ref
 * on every render.
 *
 * Worth the component rather than the three separate `fetcher.Form`s it replaces. Three
 * forms in one cell is three elements laying themselves out independently, and they
 * carried `gap="small"` — which the spacing scale documents as *larger* than `small-100`,
 * so the three halves of one decision sat further apart than the parts of any other row
 * in the app.
 */
function DriftDecision({
  event,
  fetcher,
  busy,
  onDecide,
}: {
  event: DriftRow;
  fetcher: FetcherWithComponents<ActionData>;
  busy: boolean;
  /** Told before the decision posts, so the page knows where focus goes when the row leaves. */
  onDecide: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const resolution = useRef<HTMLInputElement>(null);

  const resolve = (value: DriftResolution) => {
    if (resolution.current) resolution.current.value = value;
    onDecide();
    form.current?.requestSubmit();
  };

  return (
    <s-table-row>
      <s-table-cell>{event.title}</s-table-cell>
      <s-table-cell>{event.expected ?? <Blank />}</s-table-cell>
      {/* Was a warning badge wrapped round the price. A badge is a status and a price is
          a value, so the column could not align with the one beside it and the number a
          merchant came here to compare rendered as a label. Every row on this page is
          drift; the page says so once, at the top, rather than once per row. */}
      <s-table-cell>{event.observed ?? <Blank />}</s-table-cell>
      <s-table-cell>{event.campaignName ?? <Blank />}</s-table-cell>
      <s-table-cell>
        <fetcher.Form method="post" ref={form}>
          <input type="hidden" name="eventId" value={event.id} />
          {/* Defaults to the choice that changes nothing. A missing or unrecognised
              intent should fall safe, the way the imports' dry run does. */}
          <input type="hidden" name="resolution" ref={resolution} value="ignore" readOnly />
          <ActionRow>
            {/* "Keep the change" only while there is a change to keep. A run that wrote over
                the edit since leaves nothing on the storefront to adopt (#755). */}
            {RESOLUTIONS.filter((choice) => choice.value !== "adopt" || event.stillShown).map((choice) => (
              <s-button
                key={choice.value}
                type="button"
                tone={choice.tone}
                loading={busy || undefined}
                // The variant, and for Keep what it does, in the name a screen reader reads
                // (#796): three identical names a row, and the consequential one told apart
                // only by colour.
                accessibilityLabel={choiceName(choice.value, event.title)}
                onClick={() => resolve(choice.value)}
              >
                {choice.label}
              </s-button>
            ))}
          </ActionRow>
        </fetcher.Form>
      </s-table-cell>
    </s-table-row>
  );
}
