import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { calendarFor, todayIn } from "../services/calendar.server";
import { addDays } from "../lib/scheduling/calendar";
import { CalendarGrid } from "../components/CalendarGrid";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";

export const loader = withGuard("/app/campaigns/calendar", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const view = url.searchParams.get("view") === "week" ? "week" : "month";
  const on = url.searchParams.get("on") ?? todayIn(shop.timezone);

  const calendar = await calendarFor(shop.id, shop.timezone, { view, on });

  // Neighbouring periods, computed here rather than in the browser so the links work
  // without JavaScript and are the same arithmetic the grid was built from.
  const step = view === "week" ? 7 : 0;
  const previous = view === "week" ? addDays(on, -step) : monthStep(on, -1);
  const next = view === "week" ? addDays(on, step) : monthStep(on, 1);

  return {
    ...calendar,
    view,
    on,
    previous,
    next,
    today: todayIn(shop.timezone),
  };
});

/** The same day-of-month in an adjacent month, clamped to a day that exists. */
function monthStep(date: string, months: number): string {
  const [year, month] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export default function Calendar() {
  const { days, overlaps, timeZone, view, on, previous, next, today } =
    useLoaderData<typeof loader>();

  const heading = view === "week" ? `Week of ${on}` : monthName(on);

  return (
    <s-page heading="Calendar">
      <s-section heading={heading}>
        <s-paragraph>
          <s-text>
            Dates and times are your store&rsquo;s, in {timeZone}. Click a day to schedule
            a campaign starting then.
          </s-text>
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <Link to={`/app/campaigns/calendar?view=${view}&on=${previous}`}>
            <s-button type="button" variant="tertiary">
              Previous
            </s-button>
          </Link>
          <Link to={`/app/campaigns/calendar?view=${view}&on=${today}`}>
            <s-button type="button" variant="tertiary">
              Today
            </s-button>
          </Link>
          <Link to={`/app/campaigns/calendar?view=${view}&on=${next}`}>
            <s-button type="button" variant="tertiary">
              Next
            </s-button>
          </Link>
          <Link to={`/app/campaigns/calendar?view=${view === "week" ? "month" : "week"}&on=${on}`}>
            <s-button type="button" variant="tertiary">
              {view === "week" ? "Month view" : "Week view"}
            </s-button>
          </Link>
        </s-stack>

        <CalendarGrid days={days} today={today} />
      </s-section>

      {overlaps.length > 0 ? (
        <s-section heading="Campaigns running at the same time">
          <s-paragraph>
            <s-text>
              Overlapping campaigns never stack. The higher priority one wins every
              product they share, and the preview shows exactly which price each gets.
            </s-text>
          </s-paragraph>

          {overlaps.map((overlap) => (
            <s-paragraph key={`${overlap.a.id}-${overlap.b.id}`}>
              <s-text>
                <s-text>{overlap.a.name}</s-text> and <s-text>{overlap.b.name}</s-text> run
                together
                {overlap.sharedVariants > 0
                  ? ` and share ${overlap.sharedVariants} ${
                      overlap.sharedVariants === 1 ? "product" : "products"
                    }.`
                  : ", but have no products in common."}{" "}
              </s-text>
              {overlap.sharedVariants > 0 ? (
                <Link to={`/app/campaigns/${overlap.a.id}`}>
                  See which price each product gets
                </Link>
              ) : null}
            </s-paragraph>
          ))}
        </s-section>
      ) : null}
    </s-page>
  );
}

function monthName(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
