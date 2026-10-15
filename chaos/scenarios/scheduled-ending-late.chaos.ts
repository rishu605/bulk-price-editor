/**
 * A scheduled sale whose apply outlasts its window says it is ending late, once, and ends
 * the moment the apply finishes (#829).
 *
 * On anchor-perf a 30-minute sale over 102,132 variants was still applying 56 minutes after
 * its window closed. The revert has to wait for the apply -- one run writes a campaign's
 * prices at a time -- but nothing said so: the page read "Applying", no email went out, the
 * campaigns list showed the last attempt's failure, and the history never said the
 * scheduler had taken the campaign at all.
 *
 * A slow apply is a bulk operation the fake store holds running until told to finish, which
 * is what 100k variants look like from here. Driven through the real `tick`, the campaigns
 * list and the campaign page's own loader.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { Notification } from "../../app/lib/notifications/templates";
import { ENDING_LATE_ENTRY, toldEndingLate } from "../../app/lib/scheduling/ending-late";
import { filtersFrom, listCampaigns } from "../../app/services/campaigns/list.server";
import { tick } from "../../app/services/scheduler.server";
import { fixtureAdminClient, withChaos, type ChaosContext } from "../harness/scenario";

let endpoint = "";
let pending = { shop: "" };

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
      admin: {
        async graphql() {
          throw new Error("the page's loader made an Admin API call");
        },
      },
    }),
  },
}));

const sent: Array<{ shopId: string; notification: Notification }> = [];
vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async (shopId: string, notification: Notification) => {
    sent.push({ shopId, notification });
    return { sent: true };
  },
}));

// The scheduler passes no `forcePath`: its runs choose their path by size. Four variants are
// sent the way 102,132 would be, as one bulk operation.
let forceBulk = false;
vi.mock("../../app/lib/planning/write-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/lib/planning/write-path")>();
  return {
    ...actual,
    selectWritePath: (rowCount: number, options?: Parameters<typeof actual.selectWritePath>[1]) =>
      forceBulk && rowCount > 0
        ? { path: "bulk" as const, rowCount, reason: "sent in bulk, as a catalogue this size would be" }
        : actual.selectWritePath(rowCount, options),
  };
});

const SPEC = { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20, pollsBeforeComplete: 1_000 };
const dollars = (minor: number) => (minor / 100).toFixed(2);

/** Waits for `check` to hold, asking every 100 ms. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The fixture campaign with a window, and in `status` when one is given. */
async function windowed(chaos: ChaosContext, window: { startAt: Date; endAt: Date; revertBufferMinutes: number }, status?: "SCHEDULED") {
  const { campaignId } = chaos.fixture;
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      ...(status ? { status } : {}),
      startAt: window.startAt,
      endAt: window.endAt,
      schedule: {
        ...(campaign.schedule as object),
        kind: "window",
        startAt: window.startAt.toISOString(),
        endAt: window.endAt.toISOString(),
        revertBufferMinutes: window.revertBufferMinutes,
      } as never,
    },
  });
}

const campaignOf = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true, schedule: true } });

async function rowInList(shopId: string, campaignId: string) {
  const { campaigns } = await listCampaigns(shopId, filtersFrom(new URLSearchParams()));
  return campaigns.find((row) => row.id === campaignId)!;
}

async function statusCard(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const page = (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { lifecycle: { label: string; tone: string; explanation: string } };
  return page.lifecycle;
}

async function scheduleCard(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const page = (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { scheduleText: string };
  return page.scheduleText;
}

/** The campaign's badge on today's calendar. */
async function onCalendar(shopId: string, campaignId: string) {
  const { calendarFor } = await import("../../app/services/calendar.server");
  const view = await calendarFor(shopId, "UTC");
  const entry = view.days.flatMap((day) => day.entries).find((candidate) => candidate.campaignId === campaignId);
  return entry?.lifecycle;
}

const endingLateEmails = (campaignId: string) =>
  sent.filter(({ notification }) => "campaignId" in notification && notification.campaignId === campaignId && "endingLate" in notification && notification.endingLate);

/** The campaign's history since `since`, oldest first, as "actor: from → to · reason". */
async function moves(shopId: string, campaignId: string, since: Date) {
  const entries = await prisma.auditLogEntry.findMany({
    where: { shopId, entityId: campaignId, action: "campaign.transition", createdAt: { gte: since } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return entries.map((entry) => {
    const before = entry.before as { status?: string } | null;
    const after = entry.after as { status?: string; reason?: string } | null;
    return `${entry.actor}: ${before?.status} → ${after?.status} · ${after?.reason ?? ""}`;
  });
}

describe("chaos: a scheduled sale whose apply outlasts its window", () => {
  it("says it is ending late, once, while the scheduler applies it, and reverts the moment the apply finishes", async () => {
    await withChaos("ending-late-scheduled", SPEC, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, baseline } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      pending = { shop: domain };
      forceBulk = true;
      sent.length = 0;

      // Started a minute ago; reverting is due ten seconds from now, with the apply still
      // in Shopify's hands.
      const now = Date.now();
      await windowed(chaos, { startAt: new Date(now - 60_000), endAt: new Date(now + 70_000), revertBufferMinutes: 1 }, "SCHEDULED");
      const since = new Date(now - 1_000);

      // The scheduler runs a scheduled apply inside its tick, so this tick is busy for as
      // long as Shopify takes.
      const busy = tick(new Date());

      await until(async () => (await prisma.bulkOperationRecord.count({ where: { shopId } })) > 0, "Shopify to accept the apply");
      const applying = await rowInList(shopId, campaignId);
      expect(applying.state).toBe("APPLYING");
      expect(applying.lastRun, "the list did not show the run going on").toMatchObject({ kind: "APPLY", inProgress: true });
      expect(applying.lastRun?.atShopify).toMatchObject({ of: 4, live: true });

      // Its revert comes due while it applies. Nothing else can look -- the tick is inside
      // the apply -- so the apply says so itself, once.
      // The mark is written first and the email follows its history note, so wait for both.
      await until(
        async () => toldEndingLate((await campaignOf(campaignId)).schedule) && endingLateEmails(campaignId).length > 0,
        "the apply to say it is ending late",
        45_000,
      );
      expect((await campaignOf(campaignId)).status).toBe("APPLYING");
      expect(endingLateEmails(campaignId), "the merchant was not told, or was told twice").toHaveLength(1);
      const card = await statusCard(campaignId);
      expect(card.label, "the page read Applying as if nothing were wrong").toBe("Applying — ending late");
      expect(card.tone).toBe("warning");
      expect(card.explanation).toMatch(/the revert begins as soon as the apply finishes/);
      expect((await rowInList(shopId, campaignId)).lifecycle.label).toBe("Applying — ending late");
      // The calendar says what the list says (#1056), and the Schedule card no longer
      // promises a revert that begins early.
      expect(await onCalendar(shopId, campaignId), "the calendar read Applying as if nothing were wrong").toEqual({
        label: "Applying — ending late",
        tone: "warning",
      });
      expect(await scheduleCard(campaignId)).toMatch(/It is still applying, so its revert waits for that to finish and begins as soon as it does\.$/);

      // A second worker ticking meanwhile neither reverts under the apply nor tells again.
      await tick(new Date());
      expect((await campaignOf(campaignId)).status).toBe("APPLYING");
      expect(await prisma.campaignRun.count({ where: { campaignId, kind: "REVERT" } }), "a revert ran under the apply").toBe(0);
      expect(endingLateEmails(campaignId), "told again").toHaveLength(1);

      // Shopify finishes. The tick that ran the apply reverts at once, not a tick later.
      chaos.fake.finishBulkOnNextPoll();
      await busy;
      expect((await campaignOf(campaignId)).status, "the sale outlived its window by another tick").toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(dollars(baseline.get(gid)!));
      const finished = await rowInList(shopId, campaignId);
      expect(finished.lastRun).toMatchObject({ kind: "REVERT", inProgress: false, status: "COMPLETED" });

      // The history, in order, every move the scheduler's: taken, late, applied, taken back.
      const history = await moves(shopId, campaignId, since);
      expect(history).toEqual([
        "scheduler: SCHEDULED → APPLYING · scheduled start",
        `scheduler: APPLYING → APPLYING · ${ENDING_LATE_ENTRY}`,
        expect.stringMatching(/^scheduler: APPLYING → ACTIVE · apply finished: 4 verified/),
        "scheduler: ACTIVE → REVERTING · scheduled end",
        expect.stringMatching(/^scheduler: REVERTING → COMPLETED · revert finished: 4 verified/),
      ]);
      expect(endingLateEmails(campaignId)).toHaveLength(1);
    });
  });

  it("is told by the tick for an apply the worker's queue is running, and the first tick after the apply ends it", async () => {
    await withChaos("ending-late-queued", SPEC, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, baseline } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      pending = { shop: domain };
      forceBulk = false;
      sent.length = 0;

      // Applied by hand (the worker runs it), its revert an hour away.
      const now = Date.now();
      await windowed(chaos, { startAt: new Date(now - 60 * 60_000), endAt: new Date(now + 60 * 60_000), revertBufferMinutes: 5 }, "SCHEDULED");
      const applying = chaos.apply({ forcePath: "bulk" });
      await until(async () => (await prisma.bulkOperationRecord.count({ where: { shopId } })) > 0, "Shopify to accept the apply");

      // The hour passes while Shopify works: the window's end is now behind it. The run's
      // own watch is set for the end it started with, so only the tick can see this one.
      await windowed(chaos, { startAt: new Date(now - 2 * 60 * 60_000), endAt: new Date(now - 60_000), revertBufferMinutes: 5 });
      expect((await campaignOf(campaignId)).status).toBe("APPLYING");
      const listed = await rowInList(shopId, campaignId);
      expect(listed.lifecycle.label, "said only once somebody had been told").toBe("Applying — ending late");
      expect(listed.lastRun).toMatchObject({ kind: "APPLY", inProgress: true });
      expect(endingLateEmails(campaignId)).toHaveLength(0);

      for (let i = 0; i < 2; i++) await tick(new Date());
      expect((await campaignOf(campaignId)).status).toBe("APPLYING");
      expect(await prisma.campaignRun.count({ where: { campaignId, kind: "REVERT" } }), "a revert ran under the apply").toBe(0);
      expect(endingLateEmails(campaignId), "the merchant was not told, or was told every tick").toHaveLength(1);
      expect(toldEndingLate((await campaignOf(campaignId)).schedule)).toBe(true);
      const notes = (await moves(shopId, campaignId, new Date(now - 1_000))).filter((move) => move.endsWith(ENDING_LATE_ENTRY));
      expect(notes).toEqual([`scheduler: APPLYING → APPLYING · ${ENDING_LATE_ENTRY}`]);

      // The apply finishes; the next tick ends the sale.
      chaos.fake.finishBulkOnNextPoll();
      await applying;
      expect((await campaignOf(campaignId)).status).toBe("ACTIVE");
      await tick(new Date());
      expect((await campaignOf(campaignId)).status).toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(dollars(baseline.get(gid)!));
      expect(endingLateEmails(campaignId)).toHaveLength(1);
    });
  });
});
