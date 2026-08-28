/**
 * "Scheduled: 1" is a count of a thing whose entire value is *when*.
 *
 * The question a merchant opens this app with is whether anything is about to change
 * their prices and whether there is time to stop it, and a number is the one shape that
 * cannot answer it.
 */

import { describe, expect, it } from "vitest";

import { nextMoments } from "./upcoming";

const NOW = "2026-08-28T12:00:00.000Z";

const campaign = (
  id: string,
  startAt: string | null,
  endAt: string | null,
  status = "SCHEDULED",
) => ({ id, name: `Campaign ${id}`, status, startAt, endAt });

describe("the next moment of a campaign", () => {
  it("is its start when the start has not happened", () => {
    const [next] = nextMoments(
      [campaign("a", "2026-08-30T09:00:00.000Z", "2026-09-05T09:00:00.000Z")],
      NOW,
    );

    expect(next.kind).toBe("starts");
    expect(next.at).toBe("2026-08-30T09:00:00.000Z");
  });

  it("is its end once it is running", () => {
    // A revert changes prices exactly as much as an apply does, and a merchant is far
    // likelier to have forgotten one is coming.
    const [next] = nextMoments(
      [campaign("a", "2026-08-20T09:00:00.000Z", "2026-08-31T09:00:00.000Z", "ACTIVE")],
      NOW,
    );

    expect(next.kind).toBe("ends");
    expect(next.at).toBe("2026-08-31T09:00:00.000Z");
  });

  it("leaves out a campaign with nothing ahead of it", () => {
    // Running with no end date belongs in "what is live right now", which is a different
    // question from "what is about to change".
    expect(nextMoments([campaign("a", "2026-08-20T09:00:00.000Z", null, "ACTIVE")], NOW)).toEqual(
      [],
    );
  });

  it("leaves out one whose window is entirely behind us", () => {
    expect(
      nextMoments([campaign("a", "2026-08-01T09:00:00.000Z", "2026-08-10T09:00:00.000Z")], NOW),
    ).toEqual([]);
  });
});

describe("the order they are shown in", () => {
  it("is soonest first, whichever kind of moment it is", () => {
    // The database can sort by a column; it cannot sort by "whichever of these two
    // columns has not happened yet", which is the whole reason this function exists.
    const moments = nextMoments(
      [
        campaign("later-start", "2026-09-10T09:00:00.000Z", null),
        campaign("soon-end", "2026-08-01T09:00:00.000Z", "2026-08-29T09:00:00.000Z", "ACTIVE"),
        campaign("soonest-start", "2026-08-28T18:00:00.000Z", null),
      ],
      NOW,
    );

    expect(moments.map((moment) => moment.id)).toEqual([
      "soonest-start",
      "soon-end",
      "later-start",
    ]);
  });

  it("shows only as many as asked for", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      campaign(`c${index}`, `2026-09-0${index + 1}T09:00:00.000Z`, null),
    );

    expect(nextMoments(many, NOW)).toHaveLength(4);
    expect(nextMoments(many, NOW, 2)).toHaveLength(2);
  });

  it("takes its clock from the caller, so the page renders the same words twice", () => {
    const campaigns = [campaign("a", "2026-08-28T18:00:00.000Z", null)];

    expect(nextMoments(campaigns, NOW)).toHaveLength(1);
    expect(nextMoments(campaigns, "2026-08-29T00:00:00.000Z")).toEqual([]);
  });
});
