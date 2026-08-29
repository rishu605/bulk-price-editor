/**
 * What the campaigns index asks the database for, once archiving exists.
 *
 * Two things can go quietly wrong here and neither shows up in a rendered row. The list
 * can stop excluding archived campaigns, which puts back in front of a merchant exactly
 * what they filed away. And the "needs a decision" badge can go on counting them, which
 * is a number pointing at rows that are not in the list — the worst kind of alert,
 * because the only way to act on it is to guess.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { campaign: { findMany: vi.fn(), count: vi.fn() } },
}));
vi.mock("../../db.server", () => ({ default: prisma }));

import { filtersFrom, listCampaigns } from "./list.server";

const filters = (query = "") => filtersFrom(new URLSearchParams(query));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.campaign.findMany.mockResolvedValue([]);
  prisma.campaign.count.mockResolvedValue(0);
});

const rowQuery = () => prisma.campaign.findMany.mock.calls[0]![0].where;
/** The second `count` is the attention badge; the first is the page total. */
const attentionQuery = () => prisma.campaign.count.mock.calls[1]![0].where;

describe("the default list", () => {
  it("leaves out what the merchant filed away", async () => {
    await listCampaigns("shop", filters());

    expect(rowQuery().archivedAt).toBeNull();
  });

  it("counts only unarchived campaigns as needing a decision", async () => {
    // The badge is deliberately unfiltered in every other respect -- a merchant narrowed
    // to DRAFT still has to be told a run went partial. Archiving is the one exception,
    // because the campaign is no longer in any list the badge could send them to.
    await listCampaigns("shop", filters());

    expect(attentionQuery()).toMatchObject({ shopId: "shop", archivedAt: null });
  });
});

describe("the archive", () => {
  it("shows only what was filed away", async () => {
    await listCampaigns("shop", filters("archived=1"));

    expect(rowQuery().archivedAt).toEqual({ not: null });
  });

  it("still narrows by status and search, because both controls work at once", async () => {
    // The reason archiving is not a seventh status tab: a merchant looking for an
    // archived campaign is usually looking for a finished one.
    await listCampaigns("shop", filters("archived=1&status=COMPLETED&q=summer"));

    expect(rowQuery()).toMatchObject({ archivedAt: { not: null }, status: "COMPLETED" });
  });
});

describe("search", () => {
  it("looks in the note as well as the name", async () => {
    // The point of having a note. "Why did we run this" is not a question a merchant can
    // answer by remembering what they called it.
    await listCampaigns("shop", filters("q=competitor"));

    expect(rowQuery().OR).toEqual([
      { name: { contains: "competitor", mode: "insensitive" } },
      { note: { contains: "competitor", mode: "insensitive" } },
    ]);
  });

  it("asks for no name match at all when nothing was typed", async () => {
    await listCampaigns("shop", filters());

    expect(rowQuery()).not.toHaveProperty("OR");
  });
});
