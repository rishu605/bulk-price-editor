/**
 * A scheduled start whose run throws (#975).
 *
 * The scheduler claims a due campaign (SCHEDULED → APPLYING) and runs it. A run that threw
 * gave the claim back to SCHEDULED without `quietIfRepeated`, so the next tick claimed it,
 * was refused again, and wrote the release to the campaign's history again: one entry every
 * thirty seconds for as long as its window stayed open. Only refusals that *return* were
 * recorded once (#701).
 *
 * Two kinds of throw, told apart by the error's class:
 *
 *   - refused for good -- its segment was deleted (#776), a blocking guardrail. Recorded
 *     once on the campaign, which reads "Scheduled — couldn't start" and says why; the
 *     merchant is emailed once; no later tick claims it, logs it or emails again. New dates
 *     are a new start, which the scheduler does try.
 *   - a blip -- the database unreachable. Retried every tick, said once, and the sale starts
 *     on the first tick after it passes.
 *
 * Driven through the real `tick`. Replaced: `adminClientForShop` (the fixture shop has no
 * Shopify session), `notify` (a recorder), and `guardrailsFor`, which the blip scenario
 * makes throw the way an unreachable database does.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { SCHEDULER_ACTOR } from "../../app/lib/audit/actor";
import type { Notification } from "../../app/lib/notifications/templates";
import { filtersFrom, listCampaigns } from "../../app/services/campaigns/list.server";
import { reschedule } from "../../app/services/campaigns/schedule-control.server";
import { tick } from "../../app/services/scheduler.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import { createSegment } from "../../app/services/segments-crud.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(endpoint) };
});

const sent: Array<{ shopId: string; notification: Notification }> = [];
vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async (shopId: string, notification: Notification) => {
    sent.push({ shopId, notification });
    return { sent: true };
  },
}));

/** While true, reading the shop's guardrails fails as a database that cannot be reached does. */
let databaseDown = false;
vi.mock("../../app/services/settings.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/settings.server")>();
  return {
    ...actual,
    guardrailsFor: async (shopId: string) => {
      if (databaseDown) {
        throw Object.assign(new Error("Can't reach database server at `db:5432`"), {
          name: "PrismaClientKnownRequestError",
          code: "P1001",
        });
      }
      return actual.guardrailsFor(shopId);
    },
  };
});

const HOUR = 60 * 60_000;
const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

/** The fixture campaign SCHEDULED, its start five minutes ago: the next tick applies it. */
async function dueToStart(chaos: ChaosContext, extra: Record<string, unknown> = {}) {
  endpoint = chaos.server.endpoint();
  const { campaignId } = chaos.fixture;
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() - 5 * 60_000);
  const endAt = new Date(Date.now() + 24 * HOUR);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "SCHEDULED",
      startAt,
      endAt,
      schedule: {
        ...(campaign.schedule as object),
        ...extra,
        kind: "window",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      } as never,
    },
  });
}

const campaignOf = (id: string) =>
  prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true, updatedAt: true, schedule: true } });

/** The campaign's history, as its page reads it: every recorded transition, oldest first. */
const historyOf = (shopId: string, campaignId: string) =>
  prisma.auditLogEntry
    .findMany({
      where: { shopId, entityId: campaignId, action: "campaign.transition" },
      orderBy: { createdAt: "asc" },
      select: { actor: true, before: true, after: true },
    })
    .then((rows) =>
      rows.map((row) => ({
        actor: row.actor,
        from: (row.before as { status?: string }).status,
        to: (row.after as { status?: string }).status,
        reason: (row.after as { reason?: string }).reason ?? "",
      })),
    );

const emailsAbout = (campaignId: string) =>
  sent.filter(({ notification }) => "campaignId" in notification && notification.campaignId === campaignId);

const failuresOf = (result: Awaited<ReturnType<typeof tick>>, campaignId: string) =>
  result.failures.filter((failure) => failure.campaignId === campaignId);

async function rowInList(shopId: string, campaignId: string) {
  const { campaigns } = await listCampaigns(shopId, filtersFrom(new URLSearchParams("status=all")));
  return campaigns.find((row) => row.id === campaignId);
}

describe("chaos: a scheduled start refused for good", () => {
  it("whose segment was deleted says so once, emails once, and no later tick claims it again", async () => {
    await withChaos("scheduled-refused-segment", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      // A campaign on a segment that is gone (#776): one saved before deleting was refused
      // for a scheduled campaign, or one whose segment went in a race with the scheduler.
      const segment = await createSegment(shopId, { name: "Gone", kind: "FROZEN", variantGids });
      await dueToStart(chaos, { segmentId: segment.id });
      await prisma.segment.delete({ where: { id: segment.id } });
      sent.length = 0;

      const first = await tick(new Date());
      expect(failuresOf(first, campaignId), "a refusal reported as a failure of ours").toEqual([]);
      expect(first.refused).toBeGreaterThanOrEqual(1);

      const after = await campaignOf(campaignId);
      expect(after.status, "left claimed, or moved somewhere the merchant cannot act from").toBe("SCHEDULED");
      const history = await historyOf(shopId, campaignId);
      expect(history, "said more than once, or not at all").toHaveLength(1);
      expect(history[0].actor).toBe(SCHEDULER_ACTOR);
      expect(history[0].reason).toMatch(/couldn't start on schedule, and the schedule won't try this start again/);
      expect(history[0].reason).toMatch(/segment was deleted.*Duplicate it/);

      const emails = emailsAbout(campaignId);
      expect(emails, "the merchant who asked to hear about failures heard nothing").toHaveLength(1);
      expect(emails[0].notification).toMatchObject({ kind: "run-failed", notStarted: true });

      // Visible where the merchant looks, not only in the history.
      const row = await rowInList(shopId, campaignId);
      expect(row?.lifecycle.label).toBe("Scheduled — couldn't start");
      expect(row?.lifecycle.explanation).toMatch(/segment was deleted/);

      // Ninety more seconds of the worker: nothing claims, records, emails or reports it.
      for (let i = 2; i <= 4; i++) {
        const later = await tick(new Date());
        expect(failuresOf(later, campaignId), `tick ${i} reported it as a failure`).toEqual([]);
      }
      const settled = await campaignOf(campaignId);
      expect(settled.status).toBe("SCHEDULED");
      expect(settled.updatedAt.getTime(), "a later tick claimed it again").toBe(after.updatedAt.getTime());
      expect(await historyOf(shopId, campaignId), "a later tick wrote to its history").toHaveLength(1);
      expect(emailsAbout(campaignId), "a later tick emailed again").toHaveLength(1);

      expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(0);
      expect(chaos.fake.writeLog).toHaveLength(0);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
    });
  });

  it("by a blocking guardrail is left alone until its dates move, and the new start runs", async () => {
    await withChaos("scheduled-refused-guardrail", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      // A floor above every price, set to block rather than clamp (as stranded-claim does).
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });
      await prisma.campaign.update({ where: { id: campaignId }, data: { guardrailViolationPolicy: "block" } });
      await dueToStart(chaos);
      sent.length = 0;

      for (let i = 1; i <= 3; i++) {
        const result = await tick(new Date());
        expect(failuresOf(result, campaignId), `tick ${i}`).toEqual([]);
      }
      const history = await historyOf(shopId, campaignId);
      expect(history).toHaveLength(1);
      expect(history[0].actor).toBe(SCHEDULER_ACTOR);
      expect(history[0].reason).toMatch(/A guardrail stopped this run before anything was written/);
      expect(history[0].reason, "the log's sentence, gid and all, reached the merchant").not.toMatch(/gid:\/\//);
      expect(emailsAbout(campaignId)).toHaveLength(1);
      expect((await campaignOf(campaignId)).status).toBe("SCHEDULED");
      expect(chaos.fake.writeLog).toHaveLength(0);

      // Fixed, the floor lifted, and the start moved. `reschedule` refuses nothing about the
      // instant itself (its page checks that), so the new start can already have arrived:
      // a new start, which the scheduler tries.
      await writeSettings(shopId, DEFAULT_SETTINGS);
      const start = new Date(Date.now() - 60_000).toISOString();
      const end = new Date(Date.now() + 24 * HOUR).toISOString();
      await reschedule(shopId, campaignId, { startUtc: start, endUtc: end, clockNotes: [], zone: "UTC" }, "staff:1");
      expect((await rowInList(shopId, campaignId))?.lifecycle.label, "the old refusal outlived the old start").toBe(
        "Scheduled",
      );

      const result = await tick(new Date());
      expect(failuresOf(result, campaignId)).toEqual([]);
      expect((await campaignOf(campaignId)).status).toBe("ACTIVE");
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid)).toBe((Math.round(baseline.get(gid)! * 0.8) / 100).toFixed(2));
      }
    });
  });
});

describe("chaos: a scheduled start that hits a blip", () => {
  it("is retried every tick, said once, and starts on the first tick after the blip", async () => {
    await withChaos("scheduled-blip-retried", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      await dueToStart(chaos);
      sent.length = 0;

      databaseDown = true;
      try {
        for (let i = 1; i <= 3; i++) {
          const result = await tick(new Date());
          // Still the operator's to see, every tick: this one is ours, and it may not pass.
          expect(failuresOf(result, campaignId), `tick ${i} did not try it`).toHaveLength(1);
          expect((await campaignOf(campaignId)).status, `tick ${i}`).toBe("SCHEDULED");
        }
      } finally {
        databaseDown = false;
      }

      const history = await historyOf(shopId, campaignId);
      expect(history, "every retry wrote to the history").toHaveLength(1);
      expect(history[0]).toMatchObject({ actor: SCHEDULER_ACTOR, from: "APPLYING", to: "SCHEDULED" });
      expect(history[0].reason).toMatch(/claim released without running/);
      expect(history[0].reason, "a blip was taken for a refusal").not.toMatch(/won't try this start again/);
      expect(emailsAbout(campaignId), "a blip emailed the merchant").toHaveLength(0);
      const row = await rowInList(shopId, campaignId);
      expect(row?.lifecycle.label, "a blip was shown as a refusal").toBe("Scheduled");
      expect((await campaignOf(campaignId)).schedule).not.toHaveProperty("startRefused");

      const result = await tick(new Date());
      expect(failuresOf(result, campaignId)).toEqual([]);
      expect((await campaignOf(campaignId)).status).toBe("ACTIVE");
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid)).toBe((Math.round(baseline.get(gid)! * 0.8) / 100).toFixed(2));
      }

      // Every move named the scheduler, the release and the start alike (#746).
      const moves = await historyOf(shopId, campaignId);
      expect(moves.map((move) => move.to)).toEqual(["SCHEDULED", "ACTIVE"]);
      for (const move of moves) expect(move.actor, `${move.from} → ${move.to}`).toBe(SCHEDULER_ACTOR);
    });
  });
});
