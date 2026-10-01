/**
 * Calling off or moving a scheduled campaign before it starts (#760).
 *
 * The state machine allowed `SCHEDULED -> DRAFT | CANCELLED` and nothing ever asked for
 * either, so "Black Friday 2026" could not be called off: let it go live and revert it at
 * once, or leave it and hope. An end typed before the start was saved too, and the
 * campaign sat in Scheduled forever.
 *
 * Driven through the routes' own actions and the real `tick`. Only `authenticate.admin` and
 * `adminClientForShop` are replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { tick } from "../../app/services/scheduler.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending = { shop: "" };
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(endpoint) };
});

const HOUR = 60 * 60_000;
const day = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
const time = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(11, 16);

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

/**
 * The fixture campaign, scheduled -- and due: its start passed a minute ago, so the next
 * tick applies it unless something stops it.
 */
async function scheduledAndDue(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  pending = { shop: chaos.fixture.domain };
  const { shopId, campaignId } = chaos.fixture;
  await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const startAt = new Date(Date.now() - 60_000);
  const endAt = new Date(Date.now() + 48 * HOUR);
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "SCHEDULED",
      startAt,
      endAt,
      schedule: {
        ...(campaign.schedule as object),
        kind: "window",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      } as never,
    },
  });
}

const applyRuns = (campaignId: string) => prisma.campaignRun.count({ where: { campaignId, kind: "APPLY" } });
const record = (campaignId: string) => prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });

const CATALOG = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 } as const;

describe("chaos: calling off a scheduled campaign", () => {
  it("cancels it for good: the due tick leaves it alone and no price moves", async () => {
    await withChaos("schedule-cancel", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      await scheduledAndDue(chaos);

      const result = await press(campaignId, { intent: "cancel-schedule" });
      expect(result.ok, result.message).toBe(true);
      expect(result.message).toContain("is cancelled");

      await tick(new Date());
      expect((await record(campaignId)).status, "a cancelled campaign was picked up").toBe("CANCELLED");
      expect(await applyRuns(campaignId)).toBe(0);
      for (const gid of variantGids) {
        expect(Number(chaos.fake.priceOf(gid)!.replace(".", ""))).toBe(baseline.get(gid));
      }

      const transition = await prisma.auditLogEntry.findFirstOrThrow({
        where: { shopId, action: "campaign.transition", entityId: campaignId },
        orderBy: { createdAt: "desc" },
      });
      expect(transition.after).toMatchObject({ status: "CANCELLED", reason: "cancelled before it started" });
    });
  });

  it("unschedules it to a draft with no dates, keeping its scope", async () => {
    await withChaos("schedule-unschedule", CATALOG, async (chaos) => {
      const { campaignId } = chaos.fixture;
      await scheduledAndDue(chaos);
      const before = (await record(campaignId)).schedule as Record<string, unknown>;

      const result = await press(campaignId, { intent: "unschedule" });
      expect(result.ok, result.message).toBe(true);

      await tick(new Date());
      const after = await record(campaignId);
      expect(after.status).toBe("DRAFT");
      expect(await applyRuns(campaignId)).toBe(0);
      expect(after.startAt).toBeNull();
      expect(after.endAt).toBeNull();
      const schedule = after.schedule as Record<string, unknown>;
      expect(schedule.kind).toBe("manual");
      expect(schedule.startAt).toBeUndefined();
      // Everything else in the blob is the campaign's definition, not its dates.
      expect(schedule.ast).toEqual(before.ast);
    });
  });

  it("moves its dates, refuses dates that could never run, and stays where it was", async () => {
    await withChaos("schedule-move", CATALOG, async (chaos) => {
      const { campaignId } = chaos.fixture;
      await scheduledAndDue(chaos);

      const moved = await press(campaignId, {
        intent: "reschedule",
        startDate: day(24 * HOUR),
        startTime: time(24 * HOUR),
        endDate: day(72 * HOUR),
        endTime: "23:59",
      });
      expect(moved.ok, moved.message).toBe(true);

      await tick(new Date());
      const after = await record(campaignId);
      expect(after.status, "moved into the future, it must not start today").toBe("SCHEDULED");
      expect(await applyRuns(campaignId)).toBe(0);
      expect(after.startAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
      expect((after.schedule as { ast?: unknown }).ast).toBeDefined();

      const backwards = await press(campaignId, {
        intent: "reschedule",
        startDate: day(72 * HOUR),
        startTime: "09:00",
        endDate: day(48 * HOUR),
        endTime: "09:00",
      });
      expect(backwards.ok).toBe(false);
      expect(backwards.message).toMatch(/^End: .*is not after the start.*The dates were not changed\.$/);

      const past = await press(campaignId, { intent: "reschedule", startDate: day(-48 * HOUR), startTime: "09:00" });
      expect(past.ok).toBe(false);
      expect(past.message).toMatch(/^Start: .*already passed.*Apply to storefront/);

      expect((await record(campaignId)).startAt!.getTime(), "a refused edit moved the dates").toBe(after.startAt!.getTime());
    });
  });

  it("refuses all three once the campaign has started", async () => {
    await withChaos("schedule-started", CATALOG, async (chaos) => {
      const { campaignId } = chaos.fixture;
      await scheduledAndDue(chaos);
      await tick(new Date());
      expect((await record(campaignId)).status).toBe("ACTIVE");

      for (const intent of ["cancel-schedule", "unschedule"]) {
        const refused = await press(campaignId, { intent });
        expect(refused.ok).toBe(false);
        expect(refused.message).toMatch(/is active, not scheduled.*Nothing was changed/);
      }
      expect((await record(campaignId)).status).toBe("ACTIVE");
    });
  });
});

describe("chaos: creating a campaign whose window could never run", () => {
  it("is refused, naming the field, and nothing is created", async () => {
    await withChaos("schedule-create-refused", CATALOG, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      pending = { shop: domain };
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });
      const { action } = await import("../../app/routes/app.campaigns.new");
      const { ANCHOR_ERROR } = await import("../../app/lib/errors/guard.server");

      const create = (fields: Record<string, string>) =>
        action({
          request: new Request("https://example.invalid/app/campaigns/new", {
            method: "POST",
            body: formOf({ ruleKind: "percent-change", ruleValue: "-10", ...fields }),
          }),
          params: {},
          context: {},
        } as never);

      let message = "";
      try {
        await create({
          name: "Backwards sale",
          startDate: day(72 * HOUR),
          startTime: "09:00",
          endDate: day(48 * HOUR),
          endTime: "09:00",
        });
      } catch (thrown) {
        message = (thrown as { data?: Record<string, { userMessage?: string }> }).data?.[ANCHOR_ERROR]?.userMessage ?? "";
      }
      expect(message).toMatch(/^End: .*is not after the start.*Nothing was created\.$/);
      expect(await prisma.campaign.count({ where: { shopId, name: "Backwards sale" } })).toBe(0);

      const created = await create({ name: "Forwards sale", startDate: day(48 * HOUR), endDate: day(72 * HOUR) });
      expect((created as Response).headers.get("Location")).toMatch(/^\/app\/campaigns\//);
      expect((await prisma.campaign.findFirstOrThrow({ where: { shopId, name: "Forwards sale" } })).status).toBe(
        "SCHEDULED",
      );
    });
  });
});
