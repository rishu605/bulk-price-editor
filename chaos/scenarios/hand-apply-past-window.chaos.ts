/**
 * A campaign whose window has ended, applied by hand, runs with no end (#1146).
 *
 * "QA · 1h session" on boltify-apps, scheduled 25 Sep 2026 13:00-13:20 and completed then,
 * was applied by hand on 30 Oct. Its Apply dialog said it "has finished, so the schedule will
 * not start it again"; the apply ran, four prices verified, and a minute later the scheduler
 * reverted it at "scheduled end" -- the old window's, five weeks gone. A manual apply kept the
 * window, and the scheduler treats a past end as due (#829), as it must for a sale the
 * scheduler itself started late.
 *
 * Now the dates go with the press, as Unschedule takes them (#760), and the page says so before
 * it. A window whose end is still ahead is kept: applying inside it, or before it, still ends on
 * schedule.
 *
 * Driven through the campaign page's own loader and action and the real `tick`. Only
 * `authenticate.admin` and `adminClientForShop` are replaced, with clients for the fake store.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { ENDING_LATE_ENTRY } from "../../app/lib/scheduling/ending-late";
import { formatScheduleInstant, parseSchedule } from "../../app/lib/scheduling/window";
import { tick } from "../../app/services/scheduler.server";
import { chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

/** A staff member's id, as App Bridge's session token carries it. */
const STAFF = "91614707946";
const ZONE = "America/New_York";
let pending = { shop: "", endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: STAFF },
      admin: chaosAdminContext(pending.endpoint),
    }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, pending.endpoint) };
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CATALOG = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 } as const;

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

/** The campaign page's action, as its buttons post to it. */
async function press(campaignId: string, fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  return (await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body: formOf(fields) }),
    params: { id: campaignId },
    context: {},
  } as never)) as { ok: boolean; message: string };
}

/** The schedule sentence the page's header, its Schedule card and its Apply dialog all show. */
async function scheduleLine(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const page = (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { scheduleText: string };
  return page.scheduleText;
}

/** The fixture campaign in `status`, with a window, as the editor stores one. */
async function windowed(chaos: ChaosContext, status: "SCHEDULED" | "COMPLETED", startAt: Date, endAt: Date) {
  pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
  const { shopId, campaignId } = chaos.fixture;
  await prisma.shop.update({ where: { id: shopId }, data: { timezone: ZONE } });
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status,
      startAt,
      endAt,
      schedule: {
        ...(campaign.schedule as object),
        kind: "window",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        revertBufferMinutes: 5,
        zone: ZONE,
      } as never,
    },
  });
}

const record = (campaignId: string) => prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
const reverts = (campaignId: string) => prisma.campaignRun.count({ where: { campaignId, kind: "REVERT" } });
const salePrice = (minor: number) => (Math.round(minor * 0.8) / 100).toFixed(2);

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

const CLEARED = "its window had ended, so its old dates were cleared and it runs by hand, with no end";

describe("chaos: applying by hand a campaign whose window has ended (#1146)", () => {
  it("runs a campaign completed in a past window with no end, said before the press, and the next tick leaves it Active", async () => {
    await withChaos("hand-apply-past-window", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      // Scheduled 25 Sep 13:00-13:20 and completed then, as "QA · 1h session" was.
      const startAt = new Date(Date.now() - 36 * DAY);
      const endAt = new Date(startAt.getTime() + 20 * MINUTE);
      await windowed(chaos, "COMPLETED", startAt, endAt);
      const definition = (await record(campaignId)).schedule as Record<string, unknown>;
      const since = new Date(Date.now() - 1_000);

      // Said before the press, in the line the Apply dialog restates.
      const before = await scheduleLine(campaignId);
      // Soft, so a run on a build without it still goes on to show what the next tick does.
      expect.soft(before).toContain(`to ${formatScheduleInstant(endAt.toISOString(), ZONE)} (${ZONE})`);
      expect.soft(before, "the dialog did not say what applying does with the old window").toMatch(
        /Its window has ended, so applying it now runs it by hand with no end: its old dates are cleared, and it runs until you revert it\.$/,
      );

      const applied = await press(campaignId, { intent: "apply", confirmation: "apply" });
      expect(applied.ok, applied.message).toBe(true);
      expect(applied.message).toMatch(/^Applied 2 variants/);
      expect((await record(campaignId)).status).toBe("ACTIVE");

      // The scheduler's next tick: the old end is not due, because there is no end.
      await tick(new Date());
      expect((await record(campaignId)).status, "the old window's end reverted the sale applied by hand").toBe("ACTIVE");
      expect(await reverts(campaignId)).toBe(0);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(salePrice(baseline.get(gid)!));

      // The dates went with the press, and what it prices stayed.
      const after = await record(campaignId);
      expect(after.startAt).toBeNull();
      expect(after.endAt).toBeNull();
      expect(parseSchedule(after.schedule).kind).toBe("manual");
      expect((after.schedule as Record<string, unknown>).ast).toEqual(definition.ast);

      // Its history says why its dates went, and never that it was ending late.
      const history = await moves(shopId, campaignId, since);
      expect(history.slice(0, 3)).toEqual([
        `staff:${STAFF}: COMPLETED → COMPLETED · ${CLEARED}`,
        `staff:${STAFF}: COMPLETED → APPLYING · apply requested`,
        expect.stringMatching(new RegExp(`^staff:${STAFF}: APPLYING → ACTIVE · apply finished: 2 verified`)),
      ]);
      expect(history.join("\n")).not.toContain(ENDING_LATE_ENTRY);
      expect(await scheduleLine(campaignId)).toBe("Runs when you apply it by hand.");

      // And it ends when somebody ends it.
      const reverted = await press(campaignId, { intent: "revert" });
      expect(reverted.ok, reverted.message).toBe(true);
      expect((await record(campaignId)).status).toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
    });
  });

  it("unschedules a scheduled campaign whose window closed before it was applied, then applies it", async () => {
    await withChaos("hand-apply-never-started", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      // A window that closed yesterday, never applied (#824).
      await windowed(chaos, "SCHEDULED", new Date(Date.now() - 2 * DAY), new Date(Date.now() - DAY));
      const since = new Date(Date.now() - 1_000);

      expect(await scheduleLine(campaignId)).toMatch(
        /^Was scheduled for .* \(America\/New_York\)\. Its window ended before it was applied, so applying it now runs it by hand with no end: its old dates are cleared, and it runs until you revert it\.$/,
      );

      const applied = await press(campaignId, { intent: "apply", confirmation: "apply" });
      expect(applied.ok, applied.message).toBe(true);
      const after = await record(campaignId);
      expect(after.status).toBe("ACTIVE");
      expect(after.endAt).toBeNull();
      expect(parseSchedule(after.schedule).kind).toBe("manual");

      await tick(new Date());
      expect((await record(campaignId)).status).toBe("ACTIVE");
      expect(await reverts(campaignId)).toBe(0);
      const history = await moves(shopId, campaignId, since);
      expect(history.slice(0, 2)).toEqual([
        `staff:${STAFF}: SCHEDULED → DRAFT · ${CLEARED}`,
        `staff:${STAFF}: DRAFT → APPLYING · apply requested`,
      ]);
      expect((await prisma.auditLogEntry.findMany({ where: { shopId, entityId: campaignId, action: "campaign.unschedule" } })).length).toBe(1);
    });
  });

  it("gives a claim back to the draft it made, not to Scheduled with no dates, when the apply is stopped", async () => {
    await withChaos("hand-apply-past-window-blocked", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      await windowed(chaos, "SCHEDULED", new Date(Date.now() - 2 * DAY), new Date(Date.now() - DAY));
      // A floor above every price, set to block: the run takes its claim, plans, and is stopped.
      // The store's setting, which a campaign that has not started follows (#789).
      const { DEFAULT_SETTINGS, writeSettings } = await import("../../app/services/settings.server");
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000, violationPolicy: "block" });

      const stopped = await chaos.apply().then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
      expect(stopped?.code, "the guardrail did not stop it").toBe("GUARDRAIL_BLOCKED");
      const after = await record(campaignId);
      expect(after.status, "given back to Scheduled with no dates, which never starts").toBe("DRAFT");
      expect(parseSchedule(after.schedule).kind).toBe("manual");
      expect(chaos.fake.writeLog).toHaveLength(0);
    });
  });

  it("keeps an end still ahead: a campaign applied by hand inside its window reverts there", async () => {
    await withChaos("hand-apply-inside-window", CATALOG, async (chaos) => {
      const { campaignId, variantGids, baseline } = chaos.fixture;
      // Started a minute ago, ends in two days: the scheduler would apply it this tick.
      const startAt = new Date(Date.now() - MINUTE);
      const endAt = new Date(Date.now() + 2 * DAY);
      await windowed(chaos, "SCHEDULED", startAt, endAt);
      expect(await scheduleLine(campaignId)).toMatch(/^Starts .*, reverts .*\. Reverting begins 5 minutes early/);

      const applied = await press(campaignId, { intent: "apply", confirmation: "apply" });
      expect(applied.ok, applied.message).toBe(true);
      const after = await record(campaignId);
      expect(after.status).toBe("ACTIVE");
      expect(after.endAt?.toISOString(), "an end still ahead was dropped").toBe(endAt.toISOString());
      expect(parseSchedule(after.schedule)).toMatchObject({ kind: "window", endAt: endAt.toISOString() });

      await tick(new Date());
      expect((await record(campaignId)).status).toBe("ACTIVE");

      // Two days on, as the campaign sees it: its window has passed, and the tick ends the sale.
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          startAt: new Date(Date.now() - 2 * DAY),
          endAt: new Date(Date.now() - MINUTE),
          schedule: {
            ...(after.schedule as object),
            startAt: new Date(Date.now() - 2 * DAY).toISOString(),
            endAt: new Date(Date.now() - MINUTE).toISOString(),
          } as never,
        },
      });
      await tick(new Date());
      expect((await record(campaignId)).status, "the schedule did not end a sale applied inside its window").toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
    });
  });

  it("keeps a whole window still ahead: a completed campaign applied before it says so, and keeps its dates", async () => {
    await withChaos("hand-apply-before-window", CATALOG, async (chaos) => {
      const { campaignId } = chaos.fixture;
      // Applied and reverted by hand days before the start it was set for (#768).
      const startAt = new Date(Date.now() + DAY);
      const endAt = new Date(Date.now() + 2 * DAY);
      await windowed(chaos, "COMPLETED", startAt, endAt);
      expect(await scheduleLine(campaignId)).toMatch(
        /It has finished, so the schedule will not start it again\. Applied by hand now, it keeps that end and reverts on schedule\.$/,
      );

      const applied = await press(campaignId, { intent: "apply", confirmation: "apply" });
      expect(applied.ok, applied.message).toBe(true);
      const after = await record(campaignId);
      expect(after.status).toBe("ACTIVE");
      expect(after.endAt?.toISOString()).toBe(endAt.toISOString());
      await tick(new Date());
      expect((await record(campaignId)).status).toBe("ACTIVE");
    });
  });
});
