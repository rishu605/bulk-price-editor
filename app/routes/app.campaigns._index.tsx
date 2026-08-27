import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { ActionRow } from "../components/ActionRow";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { TabBar } from "../components/TabBar";
import { SPACE } from "../lib/ui/spacing";
import { CampaignCalendar } from "../components/campaign/CampaignCalendar";
import { CampaignListView } from "../components/campaign/CampaignListView";
import { filtersFrom, listCampaigns } from "../services/campaigns/list.server";
import { calendarFor, todayIn } from "../services/calendar.server";
import { addDays } from "../lib/scheduling/calendar";

export const loader = withGuard("/app/campaigns", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const params = new URL(request.url).searchParams;
  const view = params.get("view") === "calendar" ? "calendar" : "list";
  const filters = filtersFrom(params);

  // Both views always load, so the filter and search a merchant set in one carry into
  // the other. Loading only the active view would mean switching to the calendar threw
  // away the question they had just asked.
  const list = await listCampaigns(shop.id, filters);

  if (view === "list") return { view, filters, list, calendar: null } as const;

  // `period`, not `view` — the outer `view` now chooses list or calendar, and one
  // parameter cannot mean both.
  const period = params.get("period") === "week" ? "week" : "month";
  const on = params.get("on") ?? todayIn(shop.timezone);
  const calendar = await calendarFor(shop.id, shop.timezone, { view: period, on });

  // Neighbouring periods, computed here rather than in the browser so the links work
  // without JavaScript and are the same arithmetic the grid was built from.
  const previous = period === "week" ? addDays(on, -7) : monthStep(on, -1);
  const next = period === "week" ? addDays(on, 7) : monthStep(on, 1);

  return {
    view,
    filters,
    list,
    calendar: {
      ...calendar,
      period,
      on,
      previous,
      next,
      today: todayIn(shop.timezone),
      heading: period === "week" ? `Week of ${on}` : monthName(on),
    },
  } as const;
});

/** The same day-of-month in an adjacent month, clamped to a day that exists. */
function monthStep(date: string, months: number): string {
  const [year, month] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function monthName(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function Campaigns() {
  const { view, filters, list, calendar } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  const linkTo = (next: Record<string, string>) => {
    const q = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) q.set(key, value);
      else q.delete(key);
    }
    // A page number from the previous filter is meaningless against a new one.
    if (!("page" in next)) q.delete("page");
    return `?${q}`;
  };

  return (
    <PageShell heading="Campaigns">
      {/* Counted across the shop rather than the filtered page: a campaign needing a
          decision must not be hidden by an unrelated filter. */}
      {list.attentionCount > 0 ? (
        <s-banner tone="warning">
          <s-paragraph>
            {list.attentionCount === 1
              ? "One campaign needs a decision."
              : `${list.attentionCount} campaigns need a decision.`}
          </s-paragraph>
          {/* Out of the sentence and onto its own line. A banner's whole job is to be
              acted on, and its action was three words of blue inside a paragraph. */}
          <ActionRow>
            <s-button href={linkTo({ status: "attention", view: "list" })}>Show them</s-button>
          </ActionRow>
        </s-banner>
      ) : null}

      {/* The action and the view choice are two different kinds of thing, and the row
          that mixed them read as neither. Creating a campaign is the page's primary
          action; list-versus-calendar is navigation, and now looks like the section
          tabs and the campaign tabs because it is the same control. */}
      <s-section>
        <s-stack direction="block" gap={SPACE.section}>
          {/* `s-button` takes an href, so this is one anchor styled as a button rather
              than a button nested inside a link — which is what it was, and which no
              browser is obliged to make sense of. */}
          <ActionRow>
            <s-button variant="primary" href="/app/campaigns/new">
              Create campaign
            </s-button>
          </ActionRow>

          <TabBar
            label="Campaign views"
            tabs={[
              { label: "List", href: linkTo({ view: "list" }), current: view === "list" },
              {
                label: "Calendar",
                href: linkTo({ view: "calendar" }),
                current: view === "calendar",
              },
            ]}
          />
        </s-stack>
      </s-section>

      {view === "calendar" && calendar ? (
        <CampaignCalendar {...calendar} />
      ) : (
        <CampaignListView list={list} filters={filters} linkTo={linkTo} />
      )}

      <s-section slot="aside" heading="How campaigns resolve">
        <s-paragraph>
          When two campaigns cover the same variant, exactly one wins — the higher
          priority, then the more recent. They never stack, so a variant cannot end
          up discounted twice.
        </s-paragraph>
        <s-paragraph>
          Reverting recomputes rather than restoring saved numbers. If another
          campaign still covers a variant, that campaign&rsquo;s price stays in place.
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
