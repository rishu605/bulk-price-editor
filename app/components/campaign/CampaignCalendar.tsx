
import { ActionRow } from "../ActionRow";
import { CalendarGrid } from "../CalendarGrid";
import { TabBar } from "../TabBar";
import type { calendarFor, Overlap } from "../../services/calendar.server";
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
  /** The list's archive filter, which the calendar reads too (#979). */
  archived: boolean;
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
  days, overlaps, timeZone, period, on, previous, next, today, heading, archived,
}: CampaignCalendarProps) {
  // Every link here keeps the archive filter, so moving through time does not quietly
  // swap the archived campaigns for the active ones (#979).
  const to = (target: { period?: string; on: string }, keepArchived = archived) =>
    `/app/campaigns?view=calendar&period=${target.period ?? period}&on=${target.on}${
      keepArchived ? "&archived=1" : ""
    }`;

  return (
    <>
      <Card heading={heading}>    <s-paragraph>
          <s-text>
            Dates and times are your store&rsquo;s, in {timeZone}. Click a day to schedule
            a campaign starting then.
          </s-text>
        </s-paragraph>

        {/* Said, because the grid looks the same either way: a calendar of filed-away
            campaigns that did not say so would read as the shop's schedule (#979). */}
        {archived ? (
          <s-paragraph>
            <s-text>Showing archived campaigns only, as the list&rsquo;s filter is set.</s-text>{" "}
            <s-link href={to({ on }, false)}>Show active campaigns</s-link>
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
        <Card heading="Campaigns running at the same time">      <s-paragraph>
            <s-text>
              Overlapping campaigns never stack. The higher priority one wins every
              product they share, and the preview shows exactly which price each gets.
            </s-text>
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
              the app stopped using, and there is one of these per overlap. */}
          {overlaps.some((overlap) => overlap.sharedVariants > 0) ? (
            <ActionRow>
              {/* Secondary: it sits in a row of actions rather than inside the prose,
                  so it is looked for rather than read. */}
              <s-button
                variant="secondary"
                href={`/app/campaigns/${
                  overlaps.find((overlap) => overlap.sharedVariants > 0)?.a.id
                }`}
              >
                See which price each product gets
              </s-button>
            </ActionRow>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

/**
 * What two campaigns on the calendar at once did together, after their names.
 *
 * In the past tense once both have finished (#979). "Run together and share" over two
 * campaigns completed months ago read as a collision on the storefront now. One still
 * running keeps the present: the overlap is still happening, or still to come.
 */
export function overlapSentence(overlap: Pick<Overlap, "a" | "b" | "sharedVariants">): string {
  const past = overlap.a.finished && overlap.b.finished;
  const together = past ? "ran together" : "run together";
  const products = overlap.sharedVariants === 1 ? "product" : "products";

  if (overlap.sharedVariants > 0) {
    return `${together} and ${past ? "shared" : "share"} ${overlap.sharedVariants} ${products}.`;
  }
  return `${together}, but ${past ? "had" : "have"} no products in common.`;
}
