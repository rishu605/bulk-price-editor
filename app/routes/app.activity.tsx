/**
 * The activity log.
 *
 * Everything the app or a member of staff did that changed state, with who and when
 * and what it changed. The bar is that somebody can answer "why is this product on
 * sale?" or "who turned the cost floor off?" without opening a database client.
 */

import { formatCount } from "../lib/format/display";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { activity } from "../services/activity.server";
import { activityCsv } from "../lib/reporting/activity-csv";
import { ActivityTable } from "../components/ActivityTable";
import { ActionRow } from "../components/ActionRow";
import { Pagination } from "../components/Pagination";
import { EmptyState, NoMatches } from "../components/AsyncState";
import { FilterForm, clearedSearch } from "../components/FilterForm";
import { RouteBoundary } from "../components/RouteBoundary";
import { downloadCsv } from "../lib/reporting/csv";
import { describeAction } from "../lib/audit/action";
import { describeActor } from "../lib/audit/actor";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { SPACE } from "../lib/ui/spacing";

const FILTER_FIELDS = ["actor", "action", "from", "to"] as const;

/**
 * Rows per page.
 *
 * Kept small deliberately. A hundred rows of four cells each reliably rendered this
 * page blank — Polaris's `s-table` stops coping somewhere above a few hundred cells,
 * and it fails by rendering nothing rather than by erroring, so there is no console
 * message to find. Twenty-five is well inside that and is a better page size for a log
 * somebody is scanning anyway.
 */
export const PAGE_SIZE = 25;

export const loader = withGuard("/app/activity", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const filters = {
    actor: url.searchParams.get("actor") ?? undefined,
    action: url.searchParams.get("action") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);

  const result = await activity(shop.id, filters, page);
  return { ...result, page, filters, timeZone: shop.timezone };
});

export default function Activity() {
  const { entries, total, actors, actions, page, filters, timeZone } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const filtered = Boolean(filters.actor || filters.action || filters.from || filters.to);

  return (
    <PageShell heading="Activity" backTo={{ href: "/app", label: "Home" }}>
      <s-section>
        <FilterForm fields={FILTER_FIELDS}>
          <s-stack gap={SPACE.section}>
            <s-select name="actor" label="Who">
              <s-option value="" defaultSelected={!filters.actor}>
                Anyone
              </s-option>
              {actors.map((actor) => (
                <s-option key={actor} value={actor} defaultSelected={filters.actor === actor}>
                  {describeActor(actor)}
                </s-option>
              ))}
            </s-select>

            {/* `describeAction`, the same call the Action column makes. #388 fixed the
                column and stopped there, so the page offered `campaign.transition` in
                this list and rendered "Campaign transition" in the cells it filtered —
                two vocabularies for one thing, one element apart. The value submitted is
                still the raw action; only what the merchant reads changes. */}
            <s-select name="action" label="What">
              <s-option value="" defaultSelected={!filters.action}>
                Any action
              </s-option>
              {actions.map((action) => (
                <s-option key={action} value={action} defaultSelected={filters.action === action}>
                  {describeAction(action)}
                </s-option>
              ))}
            </s-select>

            <s-date-field name="from" label="From" value={filters.from ?? ""} />
            <s-date-field name="to" label="To" value={filters.to ?? ""} />

            <s-button type="submit">Filter</s-button>
          </s-stack>
        </FilterForm>

        {total === 0 ? (
          filtered ? (
            <NoMatches
              noun="entries"
              description="Every action that changes state is written here as it happens — applying a campaign, editing a guardrail, resolving drift — so a narrow window or a specific actor can easily land between two of them."
              clearHref={clearedSearch(params, FILTER_FIELDS)}
            />
          ) : (
            <EmptyState
              title="Nothing has been recorded yet"
              description="Every action that changes state — applying a campaign, editing a guardrail, resolving drift — is written here as it happens, with who did it and what it changed."
            />
          )
        ) : (
          <>
            {/* `s-paragraph` is a block element, so an inline stack laid the button out
                beside a box that owns a whole line of leading and the two never shared a
                baseline. A run of text is what belongs on a row with a button. */}
            <ActionRow>
              <s-text color="subdued" fontVariantNumeric="tabular-nums">
                {formatCount(total)} entr{total === 1 ? "y" : "ies"} · times shown in{" "}
                {timeZone}
              </s-text>
              <s-button
                type="button"
                variant="tertiary"
                icon="download"
                onClick={() => downloadCsv("anchor-activity.csv", activityCsv(entries))}
              >
                Export this page (CSV)
              </s-button>
            </ActionRow>

            <ActivityTable entries={entries} timeZone={timeZone} />

            <Pagination page={page} total={total} pageSize={PAGE_SIZE} noun="entries" />
          </>
        )}
      </s-section>

      <s-section slot="aside" heading="What is kept">
        <s-paragraph>
          <s-text>
            Everything, for as long as you have the app. Retention is not a paid tier
            here — charging for the ability to find out what an app did to your prices
            would be the wrong trade.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            Actions taken by the scheduler show as “Scheduler”. Anything else carries
            the staff account that did it.
          </s-text>
        </s-paragraph>
      </s-section>
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
