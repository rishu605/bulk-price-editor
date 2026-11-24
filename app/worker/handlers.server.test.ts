import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: async () => ({ domain: "shop.myshopify.com", uninstalledAt: null }) },
  },
}));
/** The store's client: none, unless a test gives its shop a session. */
let client: unknown = null;
vi.mock("../services/admin-client.server", () => ({ adminClientForShop: async () => client }));
const refused: unknown[] = [];
vi.mock("../services/campaigns/queued-run.server", () => ({
  refuseQueuedRun: async (...args: unknown[]) => void refused.push(args),
}));
/** Shops whose lease another run holds (#809). */
const busy = new Set<string>();
const held: Array<{ shopId: string; kind: string; campaignId: string | null | undefined; keptFor?: string | null }> = [];
/** What happened to each lease a chunked run's turn took (#809, D34), by its holder. */
const turnLeases: Array<{ holder: string; ended?: "kept" | "released" | `handed to ${string}` }> = [];
vi.mock("../services/shop-lease.server", () => ({
  leaseHolder: (what: string) => `test:${what}`,
  runHolder: (runId: string) => `run:${runId}`,
  withShopLease: async (
    shopId: string,
    kind: string,
    work: () => Promise<unknown>,
    options: { campaignId?: string | null; keepFor?: (value: unknown) => string | null },
  ) => {
    if (busy.has(shopId)) return { busy: true };
    const value = await work();
    held.push({ shopId, kind, campaignId: options.campaignId, keptFor: options.keepFor?.(value) ?? null });
    return { busy: false, value };
  },
  takeShopLease: async (shopId: string, _kind: string, options: { holder: string }) => {
    if (busy.has(shopId)) return null;
    const lease: (typeof turnLeases)[number] = { holder: options.holder };
    turnLeases.push(lease);
    return {
      holder: options.holder,
      keep: async () => void (lease.ended ??= "kept"),
      release: async () => void (lease.ended ??= "released"),
      handOver: async (to: string) => void (lease.ended ??= `handed to ${to}`),
    };
  },
}));
/** What the run module answers: a run's first turn, and each later one. */
const runs = {
  first: { runId: "r1", planned: 12_000, verified: 0, failed: 0, unverified: 0, clean: false, messages: [], continues: true } as Record<string, unknown>,
  turns: [] as unknown[],
  asked: [] as unknown[],
};
vi.mock("../services/campaigns/run.server", () => ({
  runCampaign: async (...args: unknown[]) => {
    runs.asked.push(args[3]);
    return runs.first;
  },
  continueChunkedRun: async () => runs.turns.shift() ?? { kind: "over" },
}));
const scheduled: string[] = [];
/** What a scheduled job answers: nothing, unless a test has a transition go on in later turns. */
let scheduledAnswer: { runId: string; campaignId: string } | undefined;
vi.mock("../services/scheduled-run.server", () => ({
  runScheduledJob: async (campaignId: string) => {
    scheduled.push(campaignId);
    return scheduledAnswer;
  },
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
    expect(held).toEqual([{ shopId: "s2", kind: "run", campaignId: "c9", keptFor: null }]);
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

describe("a run written in chunks holds its shop from its first turn to its last (#809, D34)", () => {
  it("hands the shop to the run when its first turn only plans, and answers the run's next turn", async () => {
    const { handleJob } = await import("./handlers.server");
    client = {};
    held.length = 0;
    runs.asked.length = 0;
    try {
      const next = await handleJob("execution", { shopId: "s5", campaignId: "c1", runId: "r1", actor: "staff@example.com" });
      expect(next).toEqual({ turn: { shopId: "s5", campaignId: "c1", runId: "r1", turn: true } });
      // Asked for, so the run may plan here and write later; kept by the run, not released.
      expect(runs.asked).toEqual([expect.objectContaining({ runId: "r1", turns: true })]);
      expect(held).toEqual([{ shopId: "s5", kind: "run", campaignId: "c1", keptFor: "run:r1" }]);
    } finally {
      client = null;
    }
  });

  it("takes each later turn as the run, and keeps the shop while the run goes on", async () => {
    const { handleJob } = await import("./handlers.server");
    turnLeases.length = 0;
    const ref = { shopId: "s6", campaignId: "c1", runId: "r1", turn: true };
    runs.turns.push({ kind: "continues", runId: "r1", campaignId: "c1" });
    expect(await handleJob("execution", ref)).toEqual({ turn: ref });
    // Waiting on Shopify, the next turn asks again after a poll's interval.
    runs.turns.push({ kind: "continues", runId: "r1", campaignId: "c1", delayMs: 5_000 });
    expect(await handleJob("execution", ref)).toEqual({ turn: ref, delayMs: 5_000 });
    expect(turnLeases).toEqual([
      { holder: "run:r1", ended: "kept" },
      { holder: "run:r1", ended: "kept" },
    ]);
  });

  it("gives the shop up with the run's last turn, and leaves it with another process's turn", async () => {
    const { handleJob } = await import("./handlers.server");
    turnLeases.length = 0;
    const ref = { shopId: "s7", campaignId: "c1", runId: "r1", turn: true };
    runs.turns.push({ kind: "finished", runId: "r1", campaignId: "c1", revert: false, outcome: {} });
    expect(await handleJob("execution", ref)).toBeUndefined();
    runs.turns.push({ kind: "elsewhere" });
    expect(await handleJob("execution", ref)).toBeUndefined();
    runs.turns.push({ kind: "over" });
    expect(await handleJob("execution", ref)).toBeUndefined();
    expect(turnLeases.map((lease) => lease.ended)).toEqual(["released", "kept", "released"]);
  });

  it("waits, without writing, while another of the shop's runs took the shop after the run's lease expired", async () => {
    const { handleJob } = await import("./handlers.server");
    busy.add("s8");
    runs.turns.push({ kind: "continues", runId: "r1", campaignId: "c1" });
    try {
      expect(await handleJob("execution", { shopId: "s8", campaignId: "c1", runId: "r1", turn: true })).toBe("later");
      expect(runs.turns).toHaveLength(1);
    } finally {
      busy.delete("s8");
      runs.turns.length = 0;
    }
  });

  it("ends a scheduled start's sale in its last turn when the window closed meanwhile, under the same hold (#1053)", async () => {
    const { handleJob } = await import("./handlers.server");
    turnLeases.length = 0;
    scheduled.length = 0;
    scheduledAnswer = { runId: "r2", campaignId: "c1" };
    try {
      runs.turns.push({ kind: "finished", runId: "r1", campaignId: "c1", revert: false, outcome: {} });
      const next = await handleJob("execution", { shopId: "s9", campaignId: "c1", runId: "r1", turn: true, scheduled: "c1" });
      // The end is large too: the shop goes to its run, and its next turn is the answer.
      expect(scheduled).toEqual(["c1"]);
      expect(next).toEqual({ turn: { shopId: "s9", campaignId: "c1", runId: "r2", turn: true, scheduled: "c1" } });
      expect(turnLeases).toEqual([{ holder: "run:r1", ended: "handed to run:r2" }]);
    } finally {
      scheduledAnswer = undefined;
    }
  });
});
