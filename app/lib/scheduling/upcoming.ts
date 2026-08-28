/**
 * What happens next, and when.
 *
 * The dashboard could say "Scheduled: 1" and did. That is a count of a thing whose whole
 * value is *when* — this is a scheduling product, and the question a merchant opens it
 * with is "is anything about to change my prices?", which a number cannot answer.
 *
 * A campaign has at most two moments still ahead of it: the one where it starts, and the
 * one where it ends and prices go back. Which of the two is next depends on where the
 * clock is, so it is decided here rather than in the query — the database can order rows
 * by a column, but not by "whichever of these two columns has not happened yet".
 *
 * Pure, and given `now` rather than reading the clock, so the same page renders the same
 * words on the server and in the browser.
 */

export interface Scheduled {
  id: string;
  name: string;
  status: string;
  startAt: string | null;
  endAt: string | null;
}

export interface NextMoment {
  id: string;
  name: string;
  status: string;
  /** What the moment does to prices. */
  kind: "starts" | "ends";
  at: string;
}

/**
 * The campaigns with a moment still ahead of them, soonest first.
 *
 * A campaign already running with no end date has nothing ahead of it and is left out:
 * it belongs in "what is live right now", which is a different question. Ending is
 * treated as a moment worth announcing in its own right, because a revert changes prices
 * exactly as much as an apply does and merchants are far more likely to have forgotten
 * about it.
 */
export function nextMoments(campaigns: Scheduled[], now: string, limit = 4): NextMoment[] {
  const at = new Date(now).getTime();

  return campaigns
    .flatMap((campaign): NextMoment[] => {
      const starts = campaign.startAt ? new Date(campaign.startAt).getTime() : null;
      const ends = campaign.endAt ? new Date(campaign.endAt).getTime() : null;

      // Starting comes first when it has not happened: a campaign cannot end before it
      // begins, so if the start is ahead of us it is the nearer of the two.
      if (starts !== null && starts > at) {
        return [{ ...moment(campaign), kind: "starts", at: campaign.startAt as string }];
      }
      if (ends !== null && ends > at) {
        return [{ ...moment(campaign), kind: "ends", at: campaign.endAt as string }];
      }
      return [];
    })
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(0, limit);
}

function moment(campaign: Scheduled) {
  return { id: campaign.id, name: campaign.name, status: campaign.status };
}
