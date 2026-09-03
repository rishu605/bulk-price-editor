import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { ActionRow } from "../components/ActionRow";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { CampaignCalendar } from "../components/campaign/CampaignCalendar";
import { CampaignListView } from "../components/campaign/CampaignListView";
import { HelpNote } from "../components/HelpNote";
import { filtersFrom, listCampaigns } from "../services/campaigns/list.server";
import { duplicateCampaign } from "../services/campaigns/housekeeping.server";
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

/**
 * Duplicating from the row.
 *
 * The redirect is the feature, not a detail of it: a merchant duplicates a campaign in
 * order to change something about it, so landing them back on the list — with a new row
 * they now have to find and open — would be most of the work and none of the point.
 *
 * The web process may not write prices, and this does not: a duplicate is a draft, and a
 * draft has written nothing to a storefront.
 */
export const action = withGuard("/app/campaigns", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  if (String(form.get("intent")) !== "duplicate") {
    return { ok: false, message: "That action is not available from the campaigns list." };
  }

  const copy = await duplicateCampaign(shop.id, String(form.get("campaignId")), session.shop);

  return redirect(`/app/campaigns/${copy.id}?duplicated=1`);
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
  // For the row-level Duplicate. See the note on `CampaignListView`'s `fetcher` prop.
  const fetcher = useFetcher();

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
    <PageShell
      heading="Campaigns"
      /* One way in, and in the strip the admin keeps for it.

         It used to sit in `TabBar`'s action slot, so the row that chooses *which view
         you are looking at* was also carrying the only thing you can do to the list —
         and the title bar the admin reserves for exactly that was empty.

         Still one door. The second one was the last of the "Imports" thinking: a
         spreadsheet of exact prices creates a campaign exactly as a rule does, so "From
         a spreadsheet" was a second entrance to the same object, and a merchant had to
         know which of their two intentions the app had filed their case under before
         they could start. It is an option inside the editor now (#445), which is where
         "how should prices change" is actually asked. */
      primaryAction={{ label: "Create campaign", href: "/app/campaigns/new" }}
      /* The view switch, beside the action rather than as a second tab bar.

         The page used to open with two tab bars stacked: List/Calendar, then All/Needs a
         decision/Draft/… Both looked like tabs and they were answering different
         questions — one picks a *shape* of view, the other filters what is in it — so the
         merchant had to read both before the first campaign. The status filter is the one
         a merchant uses, so it keeps the tabs; this is one button that swaps.

         It has to sit outside the list card because the calendar replaces that card
         entirely, and a view switch that disappears in one of its two views is a trap. */
      secondaryActions={[
        view === "calendar"
          ? { label: "List", icon: "list-bulleted", href: linkTo({ view: "list" }) }
          : { label: "Calendar", icon: "calendar", href: linkTo({ view: "calendar" }) },
      ]}
    >
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



      {view === "calendar" && calendar ? (
        <CampaignCalendar {...calendar} />
      ) : (
        <CampaignListView list={list} filters={filters} linkTo={linkTo} fetcher={fetcher} />
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
