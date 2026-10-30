/**
 * A practice campaign with a schedule (#827).
 *
 * The editor showed its dates in practice mode and the create action saved them, so a
 * practice campaign -- "preview it, nothing will be written" -- came out Scheduled. From its
 * start every tick claimed it, `runCampaign` refused it with a throw, the claim was released
 * back to SCHEDULED and the release recorded: one activity entry and one worker failure every
 * thirty seconds, for ever, because nothing ever moves a campaign out of SCHEDULED but a run.
 *
 * Both ends: the create action refuses the dates, and the scheduler leaves alone the
 * practice campaigns that were saved with them before it did. Driven through the editor's
 * own action and the real `tick`; only `authenticate.admin` and `adminClientForShop` are
 * replaced, because the fixture shop has no Shopify session.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { tick } from "../../app/services/scheduler.server";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";
import { redefine } from "../harness/definition";

let pending = { shop: "" };
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

const HOUR = 60 * 60_000;
const day = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 10);

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;

describe("chaos: a practice campaign is never scheduled", () => {
  it("is refused at create when it is given a date, naming the field, and is a draft without one", async () => {
    await withChaos("practice-schedule-create", CATALOG, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      pending = { shop: domain };
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });
      const { action } = await import("../../app/routes/app.campaigns.new");
      const { ANCHOR_ERROR } = await import("../../app/lib/errors/guard.server");

      const create = async (fields: Record<string, string>) => {
        try {
          return await action({
            request: new Request("https://example.invalid/app/campaigns/new", {
              method: "POST",
              body: formOf({ practice: "1", ruleKind: "percent-change", ruleValue: "-10", ...fields }),
            }),
            params: {},
            context: {},
          } as never);
        } catch (thrown) {
          return (thrown as { data?: Record<string, { userMessage?: string; code?: string }> }).data?.[ANCHOR_ERROR];
        }
      };

      const refusals: Array<[Record<string, string>, RegExp]> = [
        // A start and an end, as the When card posted them.
        [
          { name: "Practice with dates", startDate: day(24 * HOUR), startTime: "09:00", endDate: day(72 * HOUR), endTime: "23:59" },
          /^Start: a practice campaign is only ever previewed, so it cannot be scheduled/,
        ],
        // A start already past, which a real campaign may have: the next tick applies it.
        [{ name: "Practice starting now", startDate: day(-HOUR) }, /^Start: a practice campaign/],
        // An end alone is about practice too, not "add a start date" -- which would lead
        // the merchant straight back to the first refusal.
        [{ name: "Practice with an end", endDate: day(72 * HOUR) }, /^End: a practice campaign/],
      ];
      for (const [fields, message] of refusals) {
        const answer = (await create(fields)) as { userMessage?: string; code?: string };
        // VALIDATION, so it is the merchant's message on the form and not a failure of ours (#741).
        expect(answer?.code, fields.name).toBe("VALIDATION");
        expect(answer?.userMessage, fields.name).toMatch(message);
        expect(answer?.userMessage, fields.name).toMatch(/Clear Start and End to keep it as practice.*Nothing was created\.$/);
        expect(await prisma.campaign.count({ where: { shopId, name: fields.name } }), `${fields.name} was created`).toBe(0);
      }

      // The same rule for a caller that does not come through the editor.
      const { createCampaign } = await import("../../app/services/campaigns/model.server");
      await expect(
        createCampaign(shopId, {
          name: "Practice from elsewhere",
          ast: { groups: [] },
          rule: { kind: "percent-change", percent: -10 },
          compareAtPolicy: { kind: "leave" },
          practice: true,
          schedule: { kind: "window", startAt: new Date(Date.now() - HOUR).toISOString() },
        } as never),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(await prisma.campaign.count({ where: { shopId, name: "Practice from elsewhere" } })).toBe(0);

      // Without dates it is created, as a practice draft.
      const created = (await create({ name: "Practice, no dates" })) as Response;
      expect(created.headers.get("Location")).toMatch(/^\/app\/campaigns\//);
      const practice = await prisma.campaign.findFirstOrThrow({ where: { shopId, name: "Practice, no dates" } });
      expect(practice.status).toBe("DRAFT");
      expect(practice.practice, "the editor's practice campaign is not practice in its column (#884)").toBe(true);
      expect((practice.schedule as { practice?: boolean; kind?: string }).practice).toBe(true);
      expect((practice.schedule as { kind?: string }).kind).toBe("manual");
      expect(practice.startAt).toBeNull();
    });
  });

  it("is made a draft again by the scheduler when it already has one, once, and never run (#976)", async () => {
    await withChaos("practice-schedule-tick", CATALOG, async (chaos) => {
      await practiceScheduledAndDue(chaos);
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
      const entries = () => prisma.auditLogEntry.findMany({ where: { shopId, entityId: campaignId } });
      // By id, not by count: `entries()` has no order, and under load Postgres does not return
      // rows in the order they were written, so slicing off the first N picked up the
      // fixture's own "campaign.create" -- no actor -- as written by a tick (#1072).
      const before = new Set((await entries()).map((entry) => entry.id));

      // Three ticks, ninety seconds of the worker. Each used to claim, be refused, release
      // and write "claim released without running: This is a practice campaign…"; then #827
      // left it in SCHEDULED, where its page -- schedule controls hidden, as for any practice
      // campaign -- still said its prices would change automatically, with no way to stop it.
      for (let i = 0; i < 3; i++) {
        const result = await tick(new Date());
        expect(
          result.failures.filter((failure) => failure.campaignId === campaignId),
          `tick ${i + 1} reported the practice campaign as a failure`,
        ).toEqual([]);
        expect(await statusOf(campaignId), `tick ${i + 1} left it scheduled`).toBe("DRAFT");
        if (i === 0) {
          const unscheduled = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
          expect((unscheduled.schedule as { kind?: string; practice?: boolean }).kind).toBe("manual");
          expect((unscheduled.schedule as { practice?: boolean }).practice, "it stopped being practice").toBe(true);
          expect(unscheduled.startAt).toBeNull();
        }
      }

      // Once, by the scheduler, saying why -- not once per tick.
      const written = (await entries()).filter((entry) => !before.has(entry.id));
      expect(written.map((entry) => entry.action)).toContain("campaign.unschedule");
      expect(
        new Set(written.map((entry) => entry.actor)),
        JSON.stringify(written.map(({ action, actor }) => ({ action, actor }))),
      ).toEqual(new Set(["scheduler"]));
      expect(JSON.stringify(written)).toContain("practice campaigns never run on a schedule");
      const afterFirst = written.length;
      await tick(new Date());
      expect((await entries()).filter((entry) => !before.has(entry.id)), "a later tick wrote to it again").toHaveLength(afterFirst);

      expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(0);
      expect(chaos.fake.writeLog).toHaveLength(0);
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
      }

      // The same campaign, scheduled again and without the flag, is applied by the very next
      // tick, so the window above was genuinely due and the ticks unscheduled it because it
      // was practice -- not because of anything incidental to how the fixture was set up.
      await practiceScheduledAndDue(chaos);
      // Real in both places: the unschedule above wrote the flag into its column (#884).
      await redefine(campaignId, { practice: false });
      const result = await tick(new Date());
      expect(result.failures.filter((failure) => failure.campaignId === campaignId)).toEqual([]);
      expect(await statusOf(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid)).toBe((Math.round(baseline.get(gid)! * 0.8) / 100).toFixed(2));
      }
    });
  });
});

/**
 * The fixture campaign as a row from before #827: practice, SCHEDULED, and due -- its start
 * passed five minutes ago, so the next tick acts on it unless something stops it. Practice in
 * its schedule JSON alone, as the release before #884 wrote it, which the tick reads behind
 * the column.
 */
async function practiceScheduledAndDue(chaos: ChaosContext) {
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
        practice: true,
        kind: "window",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      } as never,
    },
  });
}

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
