
import { ActionRow } from "../ActionRow";
import { CalendarGrid } from "../CalendarGrid";
import { TabBar } from "../TabBar";
import type { calendarFor } from "../../services/calendar.server";
import { calendarFilterNote, calendarHref, type ListFilters } from "../../lib/campaigns/list-filters";
import { overlapCard, overlapSentence } from "../../lib/scheduling/overlap-card";
import { Card } from "../Card";

type Calendar = Awaited<ReturnType<typeof calendarFor>>;

export interface CampaignCalendarProps extends Calendar {
  /** Week or month. Named `period` because `view` now selects list-or-calendar. */
  period: "week" | "month";
  on: string;
  previous: string;
  next: string;
  today: string;
  heading: string;
  /** The list's status, search and archive filters, which the calendar reads too (#979, #1016). */
  filters: ListFilters;
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
  days, overlaps, timeZone, period, on, previous, next, today, heading, filters,
}: CampaignCalendarProps) {
  // Every link here keeps the list's filters, so moving through time does not quietly swap
  // the campaigns being looked at for every campaign in the shop (#979), and List
  // afterwards -- built from this page's query string -- still has them (#1016).
  const to = (target: { period?: "week" | "month"; on: string }) =>
    calendarHref({ period: target.period ?? period, on: target.on }, filters);
  const note = calendarFilterNote(filters);
  const card = overlapCard(overlaps);

  return (
    <>
      <Card heading={heading}>    <s-paragraph>
          <s-text>
            Dates and times are your store&rsquo;s, in {timeZone}. Click a day to schedule
            a campaign starting then.
          </s-text>
        </s-paragraph>

        {/* Said, because the grid looks the same either way: a calendar of filed-away
            campaigns, or of the three a search matched, that did not say so would read as
            the shop's schedule (#979, #1016). The list shows its filters as tabs and a
            search box; the calendar has neither, so this is the only place they show. */}
        {note ? (
          <s-paragraph>
            <s-text>{note.text}</s-text>{" "}
            <s-link href={calendarHref({ period, on }, note.clear.filters)}>{note.clear.label}</s-link>
          </s-paragraph>
        ) : null}

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
              href: to({ period: "month", on }),
              current: period === "month",
            },
            {
              label: "Week",
              href: to({ period: "week", on }),
              current: period === "week",
            },
          ]}
          action={
            <ActionRow>
              <s-button
                variant="tertiary"
                icon="chevron-left"
                href={to({ on: previous })}
              >
                Previous
              </s-button>
              {/* An icon, like the two either side of it. The rule is that a tertiary
                  control carries one — without it this is the only piece of plain text in
                  a row of three controls, which reads as a label between two buttons. */}
              <s-button
                variant="tertiary"
                icon="calendar"
                href={to({ on: today })}
              >
                Today
              </s-button>
              <s-button
                variant="tertiary"
                icon="chevron-right"
                href={to({ on: next })}
              >
                Next
              </s-button>
            </ActionRow>
          }
        />

        <CalendarGrid days={days} today={today} />
      </Card>

      {overlaps.length > 0 ? (
        // In the past when every overlap on it has ended (#1016): "running at the same time"
        // over two sales that ended in March read as a collision on the storefront now.
        <Card heading={card.heading}>
          <s-paragraph>
            <s-text>{card.intro}</s-text>
          </s-paragraph>

          {overlaps.map((overlap) => (
            <s-paragraph key={`${overlap.a.id}-${overlap.b.id}`}>
              <s-text>
                <s-text>{overlap.a.name}</s-text> and <s-text>{overlap.b.name}</s-text>{" "}
                {overlapSentence(overlap)}
              </s-text>
            </s-paragraph>
          ))}

          {/* Out of the sentence: an action inside a paragraph is the shape the rest of
              the app stopped using, and there is one of these per overlap.

              Only to a page that compares the pair: a campaign planned against one still
              pricing (#1016). It opened the first pair's first campaign, which could be
              one that finished months ago, with nothing to compare. */}
          {card.priceLink ? (
            <ActionRow>
              {/* Secondary: it sits in a row of actions rather than inside the prose,
                  so it is looked for rather than read. */}
              <s-button variant="secondary" href={card.priceLink}>
                See which price each product gets
              </s-button>
            </ActionRow>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
