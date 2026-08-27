import { Link } from "react-router";

import { CalendarGrid } from "../CalendarGrid";
import type { calendarFor } from "../../services/calendar.server";

type Calendar = Awaited<ReturnType<typeof calendarFor>>;

export interface CampaignCalendarProps extends Calendar {
  /** Week or month. Named `period` because `view` now selects list-or-calendar. */
  period: "week" | "month";
  on: string;
  previous: string;
  next: string;
  today: string;
  heading: string;
}

/**
 * The calendar view of the same campaigns the list shows.
 *
 * It was its own top-level nav item, which meant a merchant asking "what is running next
 * week?" had to already know a calendar existed. It is a view of the campaigns index
 * now, reached from the same page and reading the same filters.
 *
 * Overlaps are shown here rather than only on a campaign's own page: two campaigns
 * running at once is a scheduling fact, and scheduling is what a calendar is for.
 */
export function CampaignCalendar({
  days, overlaps, timeZone, period, on, previous, next, today, heading,
}: CampaignCalendarProps) {
  return (
    <>
      <s-section heading={heading}>
        <s-paragraph>
          <s-text>
            Dates and times are your store&rsquo;s, in {timeZone}. Click a day to schedule
            a campaign starting then.
          </s-text>
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <Link to={`/app/campaigns?view=calendar&period=${period}&on=${previous}`}>
            <s-button type="button" variant="tertiary">
              Previous
            </s-button>
          </Link>
          <Link to={`/app/campaigns?view=calendar&period=${period}&on=${today}`}>
            <s-button type="button" variant="tertiary">
              Today
            </s-button>
          </Link>
          <Link to={`/app/campaigns?view=calendar&period=${period}&on=${next}`}>
            <s-button type="button" variant="tertiary">
              Next
            </s-button>
          </Link>
          <Link to={`/app/campaigns?view=calendar&period=${period === "week" ? "month" : "week"}&on=${on}`}>
            <s-button type="button" variant="tertiary">
              {period === "week" ? "Month view" : "Week view"}
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
    </>
  );
}
