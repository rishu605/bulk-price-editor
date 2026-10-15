/**
 * The scheduler's claim is in the campaign's history, so the history reads in order (#829).
 *
 * The scheduler took a due campaign with a bare conditional update, so its history never
 * said it had: on anchor-perf a sale read "APPLYING → SCHEDULED, claim released without
 * running" at 17:40 and nothing more for an hour, while a second attempt, taken at 17:44,
 * was applying 102,132 prices. And the campaigns list, beside Applying, showed that first
 * attempt's failure for as long as the second was being planned.
 *
 * Driven through the real `tick`. The first attempt fails after its run began, before it
 * wrote, as the expired session did; the second is held while it plans.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { filtersFrom, listCampaigns } from "../../app/services/campaigns/list.server";
import { tick } from "../../app/services/scheduler.server";
import { fixtureAdminClient, withChaos, type ChaosContext } from "../harness/scenario";

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

// The first attempt dies after its run row exists and before any price is sent. Only this
// scenario's shop: `tick` scans every shop in the database.
let intentsFail: string | null = null;
vi.mock("../../app/services/drift.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/drift.server")>();
  return {
    ...actual,
    recordWriteIntents: async (...args: Parameters<typeof actual.recordWriteIntents>) => {
      if (args[0] === intentsFail) throw new Error("the attempt died before it wrote");
      return actual.recordWriteIntents(...args);
    },
  };
});

// The second is held while it plans, the minutes a catalogue of 100k takes.
let planning: { shopId: string; held: Promise<void>; release: () => void } | null = null;
vi.mock("../../app/services/settings.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/settings.server")>();
  return {
    ...actual,
    guardrailsFor: async (shopId: string) => {
      if (planning?.shopId === shopId) await planning.held;
      return actual.guardrailsFor(shopId);
    },
  };
});

/** A window campaign whose start has just passed, still SCHEDULED. */
async function dueToStart(chaos: ChaosContext) {
  const { campaignId } = chaos.fixture;
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() - 5 * 60_000);
  const endAt = new Date(Date.now() + 24 * 60 * 60_000);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "SCHEDULED",
      startAt,
      endAt,
      schedule: { ...(campaign.schedule as object), kind: "window", startAt: startAt.toISOString(), endAt: endAt.toISOString() } as never,
    },
  });
}

/** The campaign's whole history, oldest first, as "actor: from → to · reason". */
async function history(shopId: string, campaignId: string) {
  const entries = await prisma.auditLogEntry.findMany({
    where: { shopId, entityId: campaignId, action: "campaign.transition" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return entries.map((entry) => {
    const before = entry.before as { status?: string } | null;
    const after = entry.after as { status?: string; reason?: string } | null;
    return `${entry.actor}: ${before?.status} → ${after?.status} · ${after?.reason ?? ""}`;
  });
}

const statusOf = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

describe("chaos: the scheduler's claim, in the history and the list", () => {
  it("records each claim that runs, in order, and the list shows a retry in progress rather than the attempt that failed", async () => {
    await withChaos("scheduled-claim-history", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      await dueToStart(chaos);

      // The first attempt: taken, its run begun, and given back without writing.
      intentsFail = shopId;
      await tick(new Date());
      intentsFail = null;
      expect(await statusOf(campaignId)).toBe("SCHEDULED");
      const first = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId } });
      expect(first.status).toBe("FAILED");
      expect(await history(shopId, campaignId)).toEqual([
        "scheduler: SCHEDULED → APPLYING · scheduled start",
        expect.stringMatching(/^scheduler: APPLYING → SCHEDULED · claim released without running: /),
      ]);

      // The second, taken and still being planned.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      planning = { shopId, held, release: () => release() };
      const second = tick(new Date());
      const deadline = Date.now() + 30_000;
      while ((await statusOf(campaignId)) !== "APPLYING") {
        if (Date.now() > deadline) throw new Error("the second attempt never took the campaign");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // The list shows the attempt in progress, not the one that failed.
      const { campaigns } = await listCampaigns(shopId, filtersFrom(new URLSearchParams()));
      const row = campaigns.find((campaign) => campaign.id === campaignId)!;
      expect(row.lastRun, "the list showed the failed attempt beside Applying").toMatchObject({ kind: "APPLY", inProgress: true, status: "PLANNING" });
      // Not yet recorded: a retry that is refused again would have added nothing.
      expect(await history(shopId, campaignId)).toHaveLength(2);

      planning.release();
      await second;
      planning = null;
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((Math.round(baseline.get(gid)! * 0.8) / 100).toFixed(2));

      // Taken, given back, taken again, applied: in order, every move the scheduler's.
      const secondRun = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, status: "COMPLETED" } });
      expect(secondRun.occurrenceKey).toMatch(/#2$/);
      expect(await history(shopId, campaignId)).toEqual([
        "scheduler: SCHEDULED → APPLYING · scheduled start",
        expect.stringMatching(/^scheduler: APPLYING → SCHEDULED · claim released without running: /),
        "scheduler: SCHEDULED → APPLYING · scheduled start, tried again",
        expect.stringMatching(/^scheduler: APPLYING → ACTIVE · apply finished: 3 verified/),
      ]);
      const retaken = await prisma.auditLogEntry.findFirstOrThrow({
        where: { shopId, entityId: campaignId, action: "campaign.transition", after: { path: ["reason"], equals: "scheduled start, tried again" } },
      });
      expect((retaken.after as { runId?: string }).runId, "the retaken claim does not name the run it started").toBe(secondRun.id);
    });
  });
});
