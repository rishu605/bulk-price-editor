/**
 * A market that cannot be priced must not take the preview down with it.
 *
 * The run already refuses one market and prices the rest (`market-surfaces.server.ts`).
 * The preview did not: `planMarket` was called bare, so `UnconvertedMarketError` escaped
 * `previewCampaign`, escaped the loader, and came back as `UNKNOWN` on the generic error
 * screen. The campaign page could not be opened at all, which is the worst shape this
 * failure could take: the merchant cannot preview it, cannot revert it, and cannot read
 * what went wrong (#645).
 *
 * The assertion that matters is the one about the base surface. "Did not throw" would
 * pass if the whole market section came back empty, and an empty section is the silence
 * this bug was already producing.
 */

import { describe, expect, it, vi } from "vitest";

const { planMarket, decideMarketPath, prisma } = vi.hoisted(() => ({
  planMarket: vi.fn(),
  decideMarketPath: vi.fn(),
  prisma: {
    campaign: { findUnique: vi.fn() },
    priceListRecord: { findMany: vi.fn() },
    baseline: { findMany: vi.fn() },
  },
}));

vi.mock("../../db.server", () => ({ default: prisma }));

// The real `UnconvertedMarketError` and `describePath`, because the point of the test is
// that production's own error class is caught. A hand-rolled stand-in would pass an
// `instanceof` check against itself and prove nothing.
vi.mock("./market-plan.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./market-plan.server")>()),
  planMarket,
  decideMarketPath,
}));

vi.mock("./model.server", () => ({
  loadCampaignContext: vi.fn().mockResolvedValue({
    campaign: { name: "Black Friday", status: "SCHEDULED" },
    resolvable: [],
    ast: {},
  }),
  importIdsOf: () => [],
}));

vi.mock("./candidates.server", () => ({
  loadCandidates: vi.fn().mockResolvedValue([]),
  titleMapFor: vi.fn().mockResolvedValue(new Map([["gid://v/1", "Alpine Backpack"]])),
}));

vi.mock("../settings.server", () => ({
  guardrailsFor: vi.fn().mockResolvedValue({}),
  readSettings: vi.fn().mockResolvedValue({ minMarginPercent: null }),
}));

vi.mock("../../lib/planning/plan", () => ({
  planRun: () => ({
    kind: "ok",
    counts: { planned: 1, noop: 0, skipped: 0, clamped: 0 },
    rows: [
      {
        ref: { variantGid: "gid://v/1" },
        status: "planned",
        beforePrice: { amount: 10000, currency: "USD" },
        intendedPrice: { amount: 7500, currency: "USD" },
      },
    ],
  }),
}));

import { UnconvertedMarketError } from "./market-plan.server";
import { previewCampaign } from "./preview.server";

const CANADA = {
  priceListGid: "gid://shopify/PriceList/1",
  name: "Canada Buyers",
  currency: "CAD",
  adjustmentBps: null,
};

const unconverted = () =>
  new UnconvertedMarketError(
    CANADA.priceListGid,
    "CAD",
    "Canada Buyers returned prices that are not in CAD. It answered in USD, so they are " +
      "wrong by an exchange rate and this campaign will not price that market.",
  );

function storeAnswers(lists: (typeof CANADA)[]) {
  prisma.campaign.findUnique.mockResolvedValue({
    // `parseSurfaces` reads the column as an object, not as JSON text.
    surfaces: { priceLists: lists.map((list) => list.priceListGid) },
  });
  prisma.priceListRecord.findMany.mockResolvedValue(lists);
  prisma.baseline.findMany.mockResolvedValue([]);
}

const client = {} as never;

describe("a market that answers in the wrong currency", () => {
  it("is reported as refused instead of failing the whole preview", async () => {
    storeAnswers([CANADA]);
    planMarket.mockRejectedValue(unconverted());

    const preview = await previewCampaign("shop", "c1", { client });

    const market = preview.markets.find((entry) => entry.name === "Canada Buyers");
    expect(market?.refused).toBe(true);
    // The error's own sentence, so the preview and the run report say the same thing.
    expect(market?.explanation).toContain("CAD");
    expect(market?.explanation).toContain("USD");

    // The base surface still priced. This is the assertion that separates the fix from
    // swallowing the error and returning nothing.
    expect(preview.counts.planned).toBe(1);
    expect(preview.rows).toHaveLength(1);
  });

  it("does not give the refused market a column of its own", async () => {
    storeAnswers([CANADA]);
    planMarket.mockRejectedValue(unconverted());

    const preview = await previewCampaign("shop", "c1", { client });

    // A column of blanks beside priced markets reads as "no change here", which is the
    // opposite of what happened.
    expect(preview.rows[0]?.surfaces ?? {}).toEqual({});
  });

  it("still lets every other failure through", async () => {
    storeAnswers([CANADA]);
    planMarket.mockRejectedValue(new Error("connection reset"));

    // Only the currency refusal is expected and handled. Swallowing the rest would turn
    // a broken market into a quietly incomplete preview, which is the failure mode this
    // whole file exists to stop.
    await expect(previewCampaign("shop", "c1", { client })).rejects.toThrow(
      "connection reset",
    );
  });
});
