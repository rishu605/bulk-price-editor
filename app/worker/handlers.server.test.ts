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
/** Shops whose lease another run holds (#809). */
const busy = new Set<string>();
const held: Array<{ shopId: string; kind: string; campaignId: string | null | undefined }> = [];
vi.mock("../services/shop-lease.server", () => ({
  leaseHolder: (what: string) => `test:${what}`,
  withShopLease: async (shopId: string, kind: string, work: () => Promise<unknown>, options: { campaignId?: string | null }) => {
    if (busy.has(shopId)) return { busy: true };
    held.push({ shopId, kind, campaignId: options.campaignId });
    return { busy: false, value: await work() };
  },
}));
const scheduled: string[] = [];
vi.mock("../services/scheduled-run.server", () => ({
  runScheduledJob: async (campaignId: string) => void scheduled.push(campaignId),
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

describe("one run per shop at a time (#809)", () => {
  it("runs a job on either lane holding its shop's run lease, named for its campaign", async () => {
    const { handleJob } = await import("./handlers.server");
    held.length = 0;
    await handleJob("execution-small", { shopId: "s2", scheduled: "c9" });
    expect(scheduled).toEqual(["c9"]);
    expect(held).toEqual([{ shopId: "s2", kind: "run", campaignId: "c9" }]);
  });

  it("does nothing and answers later when another of the shop's runs holds it", async () => {
    const { handleJob } = await import("./handlers.server");
    busy.add("s3");
    scheduled.length = 0;
    try {
      expect(await handleJob("execution", { shopId: "s3", scheduled: "c1" })).toBe("later");
      expect(await handleJob("sync", { shopId: "s3", fullSync: true })).toBe("later");
      expect(scheduled).toEqual([]);
    } finally {
      busy.delete("s3");
    }
  });

  it("holds a sync on its own kind, so a shop's sync never waits for its run", async () => {
    const { handleJob } = await import("./handlers.server");
    held.length = 0;
    await handleJob("sync", { shopId: "s4" });
    expect(held.map((lease) => lease.kind)).toEqual(["sync"]);
  });
});
