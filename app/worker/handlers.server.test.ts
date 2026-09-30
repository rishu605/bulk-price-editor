import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: async () => ({ domain: "shop.myshopify.com", uninstalledAt: null }) },
  },
}));
vi.mock("../services/admin-client.server", () => ({ adminClientForShop: async () => null }));

describe("a queued run with no usable session (#707)", () => {
  it("fails where the queue sees it, instead of completing having done nothing", async () => {
    // It used to log a warning and return, which the queue records as success: the
    // queued apply or revert was gone, and nothing said it had not run.
    const { handleJob } = await import("./handlers.server");
    await expect(handleJob("execution", { shopId: "s1", campaignId: "c1" } as never)).rejects.toThrow(
      /No usable session for shop\.myshopify\.com/,
    );
  });
});
