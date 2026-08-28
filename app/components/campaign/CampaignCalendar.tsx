
import { ActionRow } from "../ActionRow";
import { CalendarGrid } from "../CalendarGrid";
import { TabBar } from "../TabBar";
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

        {/* Two different kinds of control, and they used to be one undifferentiated row of
            four identical tertiary buttons: "Previous Today Next Week view", which reads
            as four words rather than as a stepper and a choice.

            They are separated here the way the page above separates its own two, and for
            the same reason. Which period you are looking at is a *choice between views*,
            so it is the tab bar; moving through time is an *action*, so it is buttons —
            and the tab bar's action slot puts them on one line with a rule under both.

            The toggle also used to be a single button labelled with the period it would
            switch *to*, so a merchant in month view saw a button saying "Week view" and
            had to work out backwards where they were. Two tabs say it directly.

            `s-button` takes an href, so each of these is one anchor styled as a button.
            They were a button nested inside a `Link` — a button inside an anchor, which is
            not markup any browser is obliged to make sense of. */}
        <TabBar
          label="Calendar period"
          tabs={[
            {
              label: "Month",
              href: `/app/campaigns?view=calendar&period=month&on=${on}`,
              current: period === "month",
            },
            {
              label: "Week",
              href: `/app/campaigns?view=calendar&period=week&on=${on}`,
              current: period === "week",
            },
          ]}
          action={
            <ActionRow>
              <s-button
                variant="tertiary"
                icon="chevron-left"
                href={`/app/campaigns?view=calendar&period=${period}&on=${previous}`}
              >
                Previous
              </s-button>
              <s-button
                variant="tertiary"
                href={`/app/campaigns?view=calendar&period=${period}&on=${today}`}
              >
                Today
              </s-button>
              <s-button
                variant="tertiary"
                icon="chevron-right"
                href={`/app/campaigns?view=calendar&period=${period}&on=${next}`}
              >
                Next
              </s-button>
            </ActionRow>
          }
        />

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
            </s-paragraph>
          ))}

          {/* Out of the sentence: an action inside a paragraph is the shape the rest of
              the app stopped using, and there is one of these per overlap. */}
          {overlaps.some((overlap) => overlap.sharedVariants > 0) ? (
            <ActionRow>
              <s-button
                variant="tertiary"
                href={`/app/campaigns/${
                  overlaps.find((overlap) => overlap.sharedVariants > 0)?.a.id
                }`}
              >
                See which price each product gets
              </s-button>
            </ActionRow>
          ) : null}
        </s-section>
      ) : null}
    </>
  );
}
