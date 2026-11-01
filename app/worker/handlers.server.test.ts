import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: async () => ({ domain: "shop.myshopify.com", uninstalledAt: null }) },
  },
}));
vi.mock("../services/admin-client.server", () => ({ adminClientForShop: async () => null }));
const refused: unknown[] = [];
vi.mock("../services/campaigns/queued-run.server", () => ({
  refuseQueuedRun: async (...args: unknown[]) => void refused.push(args),
}));

describe("a queued run with no usable session (#707)", () => {
  it("fails where the queue sees it, instead of completing having done nothing", async () => {
    // It used to log a warning and return, which the queue records as success: the
    // queued apply or revert was gone, and nothing said it had not run.
    const { handleJob } = await import("./handlers.server");
    await expect(handleJob("execution", { shopId: "s1", campaignId: "c1" } as never)).rejects.toThrow(
      /No usable session for shop\.myshopify\.com/,
    );
    // A job from before rows were queued has no row to give back.
    expect(refused).toEqual([]);
  });

  it("gives a queued run's row back first, so the tick does not ring it into the same wall (#808)", async () => {
    const { handleJob } = await import("./handlers.server");
    const ref = { shopId: "s1", campaignId: "c1", runId: "r1", revert: false, claimedFrom: "DRAFT", actor: "staff@example.com" };
    await expect(handleJob("execution", ref)).rejects.toThrow(/No usable session/);
    expect(refused).toEqual([[ref, expect.stringMatching(/no working session for this store.*nothing was written/)]]);
  });
});
