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
import { CampaignCalendar } from "../components/campaign/CampaignCalendar";
import { CampaignListView } from "../components/campaign/CampaignListView";
import { HelpNote } from "../components/HelpNote";
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

      {/* The page's header, and not a card.

          A card is a container for content, and this one held a button and a two-item
          toggle with nothing else in it — an empty white rectangle above the actual page,
          which is what the screenshot that prompted this looked wrong for. What belongs
          here is a header: which view you are in on the left, the one thing you can do
          about it on the right, a rule under both, and no box around any of it.

          Which view / what you can do is exactly the split `TabBar` and its action slot
          make, so the row is one control rather than two stacked ones.

          `s-button` takes an href, so the action is one anchor styled as a button rather
          than a button nested inside a link — which is what it was, and which no browser
          is obliged to make sense of. */}
      <TabBar
        label="Campaign views"
        action={
          // Two ways in, one of them black. A spreadsheet of exact prices creates a
          // campaign just as a rule does -- it was filed under an "Imports" nav item,
          // which read as a fourth kind of import rather than as the second way to start
          // a sale. Secondary, not primary: most campaigns are a rule, and two black
          // buttons is two answers to "what should I do next".
          <ActionRow>
            <s-button variant="secondary" icon="import" href="/app/campaigns/import">
              From a spreadsheet
            </s-button>
            <s-button variant="primary" href="/app/campaigns/new">
              Create campaign
            </s-button>
          </ActionRow>
        }
        tabs={[
          {
            label: "List",
            // A glyph each, because these two name a *shape* of view rather than a
            // subject, and the shape is the thing being chosen between.
            icon: "list-bulleted",
            href: linkTo({ view: "list" }),
            current: view === "list",
          },
          {
            label: "Calendar",
            icon: "calendar",
            href: linkTo({ view: "calendar" }),
            current: view === "calendar",
          },
        ]}
      />

      {view === "calendar" && calendar ? (
        <CampaignCalendar {...calendar} />
      ) : (
        <CampaignListView list={list} filters={filters} linkTo={linkTo} />
      )}

      <HelpNote label="How campaigns resolve">
        <s-paragraph>
          When two campaigns cover one variant, exactly one wins — higher priority, then
          more recent. They never stack, so a variant cannot be discounted twice.
        </s-paragraph>
        <s-paragraph>
          Reverting recomputes rather than restoring saved numbers. If another campaign
          still covers a variant, its price stays.
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
