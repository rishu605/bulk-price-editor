/**
 * A campaign's times are read in the zone Shopify has for the store, and a change of zone
 * says what it moved (#799).
 *
 * On anchor-perf, freshly installed and not yet synced, the editor said "Times are in your
 * store's zone, UTC … That comes from your Shopify store settings". The store was in New
 * York. A sale typed for 9 AM on 1 Dec was saved as 09:00 UTC, and after the first sync
 * the same campaign said "Starts Dec 1, 2026, 4:00 AM (America/New_York)": five hours
 * early, and nothing on it said so.
 *
 * Driven through the routes' own loaders and actions: the editor, the edit-dates dialog,
 * the app layout every visit passes through, Home and the campaign page. Only
 * `authenticate.admin` is replaced, with an `admin` the fake Shopify answers, and the fake
 * is told which zone the store is in.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { ShopifyAdminContext } from "../../app/services/admin-client.server";
import { formatClock } from "../../app/lib/format/display";
import { describeSchedule, parseSchedule } from "../../app/lib/scheduling/window";
import { chaosAdminClient, chaosAdminContext } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending: { shop: string; admin: ShopifyAdminContext | null; endpoint: string } = { shop: "", admin: null, endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: pending.admin }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(pending.endpoint) };
});

const NEW_YORK = "America/New_York";
const LOS_ANGELES = "America/Los_Angeles";
// Next year, so the windows are always ahead of the clock, in each half of New York's year.
const YEAR = new Date().getUTCFullYear() + 1;
const WINTER = `${YEAR}-01-15`; // EST, UTC-5
const SUMMER = `${YEAR}-07-15`; // EDT, UTC-4
const CATALOG = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 } as const;

function signIn(chaos: ChaosContext) {
  pending = { shop: chaos.fixture.domain, admin: chaosAdminContext(chaos.server.endpoint()), endpoint: chaos.server.endpoint() };
}

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

type Refusal = { code?: string; userMessage?: string };

/** The editor's loader, as the page opens. */
async function editorPage() {
  const { loader } = await import("../../app/routes/app.campaigns.new");
  return (await loader({ request: new Request("https://example.invalid/app/campaigns/new"), params: {}, context: {} } as never)) as {
    timeZone: string | null;
    timeZoneNow: string;
  };
}

/** The editor's create, as its button posts it: the redirect, or the refusal it threw. */
async function create(fields: Record<string, string>): Promise<Response | Refusal> {
  const { action } = await import("../../app/routes/app.campaigns.new");
  const { ANCHOR_ERROR } = await import("../../app/lib/errors/guard.server");
  try {
    return (await action({
      request: new Request("https://example.invalid/app/campaigns/new", {
        method: "POST",
        body: formOf({ ruleKind: "percent-change", ruleValue: "-10", ...fields }),
      }),
      params: {},
      context: {},
    } as never)) as Response;
  } catch (thrown) {
    const reported = (thrown as { data?: Record<string, Refusal> }).data?.[ANCHOR_ERROR];
    if (!reported) throw thrown;
    return reported;
  }
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

/** Any authenticated visit: every page under /app passes through the layout's loader. */
async function visit() {
  const { loader } = await import("../../app/routes/app");
  await loader({ request: new Request("https://example.invalid/app"), params: {}, context: {} } as never);
}

async function home() {
  const { loader } = await import("../../app/routes/app._index");
  return (await loader({ request: new Request("https://example.invalid/app"), params: {}, context: {} } as never)) as {
    zoneShifts: Array<{ id: string; name: string; sentence: string }>;
  };
}

async function campaignPage(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { zoneShift: { from: string; to: string; moments: Array<{ which: string; typedText: string; nowText: string }> } | null };
}

const storedZone = async (shopId: string) =>
  (await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timezone: true } })).timezone;
const named = (shopId: string, name: string) => prisma.campaign.findFirstOrThrow({ where: { shopId, name } });
const zoneOf = (campaign: { schedule: unknown }) => (campaign.schedule as { zone?: string }).zone;

describe("chaos: the store's time zone, from Shopify (#799)", () => {
  it("schedules 9 AM on a store that has not synced in the zone Shopify has, not in UTC", async () => {
    await withChaos("shop-timezone-unsynced", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      signIn(chaos);
      // Freshly installed: the row's default zone and no sync ever finished. The mirror has
      // the products a products/update webhook wrote, so the editor will create a campaign.
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC", initialSyncCompletedAt: null } });
      chaos.fake.shopTimezone = NEW_YORK;

      const before = formatClock(new Date(), NEW_YORK);
      const page = await editorPage();
      const after = formatClock(new Date(), NEW_YORK);
      expect(page.timeZone, "the editor named a zone it had not read from Shopify").toBe(NEW_YORK);
      expect([before, after]).toContain(page.timeZoneNow);
      expect(await storedZone(shopId), "the zone the editor read was not recorded").toBe(NEW_YORK);

      // The create asks Shopify itself rather than trusting the row: put the row back.
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });
      for (const [name, date, startUtc] of [
        ["Winter 9 AM", WINTER, `${WINTER}T14:00:00.000Z`],
        ["Summer 9 AM", SUMMER, `${SUMMER}T13:00:00.000Z`],
      ] as const) {
        const created = await create({ name, startDate: date, startTime: "09:00", endDate: date, endTime: "23:59" });
        expect((created as Response).headers?.get("Location"), JSON.stringify(created)).toMatch(/^\/app\/campaigns\//);
        const campaign = await named(shopId, name);
        expect(campaign.status).toBe("SCHEDULED");
        expect(campaign.startAt?.toISOString(), `${name} was read in the wrong zone`).toBe(startUtc);
        expect(zoneOf(campaign), "the zone it was typed in was not recorded").toBe(NEW_YORK);
        // And the page that shows it says what the merchant typed.
        expect(describeSchedule(parseSchedule(campaign.schedule), await storedZone(shopId))).toMatch(
          /^Starts .*, 09:00, reverts .*, 23:59 \(America\/New_York\)/,
        );
      }

      // The edit-dates dialog reads the same way: 10:00 New York in summer is 14:00 UTC.
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });
      const winter = await named(shopId, "Winter 9 AM");
      const moved = await press(winter.id, { intent: "reschedule", startDate: SUMMER, startTime: "10:00" });
      expect(moved.ok, moved.message).toBe(true);
      const rescheduled = await named(shopId, "Winter 9 AM");
      expect(rescheduled.startAt?.toISOString()).toBe(`${SUMMER}T14:00:00.000Z`);
      expect(zoneOf(rescheduled)).toBe(NEW_YORK);
    });
  });

  it("says so when Shopify does not answer, and refuses a time rather than reading it in UTC", async () => {
    await withChaos("shop-timezone-unanswered", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      signIn(chaos);
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC", initialSyncCompletedAt: null } });

      const refusals: Array<[string, () => void]> = [
        ["a zone Shopify left out", () => (chaos.fake.shopTimezone = null)],
        ["a failed request", () => chaos.arm([{ fault: "server-error", match: (query) => query.includes("AnchorShopTimezone") }])],
      ];
      for (const [label, breakIt] of refusals) {
        breakIt();
        const page = await editorPage();
        expect(page.timeZone, `${label}: the editor named a zone`).toBeNull();
        expect(page.timeZoneNow).toBe("");

        const refused = (await create({ name: `Blind 9 AM (${label})`, startDate: WINTER, startTime: "09:00" })) as Refusal;
        expect(refused.code, label).toBe("VALIDATION");
        expect(refused.userMessage, label).toMatch(
          /^Start: Anchor couldn't read your store's time zone from Shopify just now.*Nothing was created\. Try again in a minute/,
        );
        expect(await prisma.campaign.count({ where: { shopId, name: `Blind 9 AM (${label})` } })).toBe(0);
        expect(await storedZone(shopId), `${label}: a guess was recorded`).toBe("UTC");
        chaos.heal();
        chaos.fake.shopTimezone = NEW_YORK;
      }

      // A campaign with no dates needs no zone, and is still created while Shopify is quiet.
      chaos.fake.shopTimezone = null;
      const created = await create({ name: "Applied by hand" });
      expect((created as Response).headers?.get("Location"), JSON.stringify(created)).toMatch(/^\/app\/campaigns\//);
      expect((await named(shopId, "Applied by hand")).status).toBe("DRAFT");
    });
  });

  it("reports a campaign set for 9 AM as moved when the store's zone changes, and keeps 9 AM when asked", async () => {
    await withChaos("shop-timezone-changed", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      signIn(chaos);
      chaos.fake.shopTimezone = NEW_YORK;
      for (const name of ["Keeps 9 AM", "Takes 6 AM"]) {
        const created = await create({ name, startDate: WINTER, startTime: "09:00", endDate: WINTER, endTime: "21:00" });
        expect((created as Response).headers?.get("Location"), JSON.stringify(created)).toMatch(/^\/app\/campaigns\//);
      }
      const keeps = await named(shopId, "Keeps 9 AM");
      const takes = await named(shopId, "Takes 6 AM");
      expect(keeps.startAt?.toISOString()).toBe(`${WINTER}T14:00:00.000Z`);
      expect((await home()).zoneShifts, "nothing has changed yet").toEqual([]);

      // The merchant moves the store to Los Angeles in Shopify, and opens the app.
      chaos.fake.shopTimezone = LOS_ANGELES;
      await visit();
      await vi.waitFor(async () => expect(await storedZone(shopId)).toBe(LOS_ANGELES), { timeout: 5_000 });

      // Nothing moved by itself...
      expect((await named(shopId, "Keeps 9 AM")).startAt?.toISOString()).toBe(`${WINTER}T14:00:00.000Z`);
      // ...and it says so, rather than showing 6:00 AM as if that had always been the time.
      const told = (await home()).zoneShifts;
      expect(told.map((row) => row.name).sort()).toEqual(["Keeps 9 AM", "Takes 6 AM"]);
      for (const row of told) {
        expect(row.sentence).toMatch(/^Its times were set in America\/New_York, and Shopify has your store in America\/Los_Angeles\./);
        expect(row.sentence).toMatch(/starts 15 Jan \d{4}, 06:00, not 09:00 and ends 15 Jan \d{4}, 18:00, not 21:00\.$/);
      }
      const page = await campaignPage(keeps.id);
      expect(page.zoneShift?.moments.map((moment) => [moment.which, moment.typedText, moment.nowText])).toEqual([
        ["start", expect.stringMatching(/, 09:00$/), expect.stringMatching(/, 06:00$/)],
        ["end", expect.stringMatching(/, 21:00$/), expect.stringMatching(/, 18:00$/)],
      ]);

      // Keep the times you set: 9 AM in Los Angeles is 17:00 UTC.
      const kept = await press(keeps.id, { intent: "keep-typed-time" });
      expect(kept.ok, kept.message).toBe(true);
      expect(kept.message).toMatch(/starts 15 Jan \d{4}, 09:00 and ends 15 Jan \d{4}, 21:00 \(America\/Los_Angeles\)/);
      const after = await named(shopId, "Keeps 9 AM");
      expect(after.startAt?.toISOString()).toBe(`${WINTER}T17:00:00.000Z`);
      expect(after.endAt?.toISOString()).toBe(`${YEAR}-01-16T05:00:00.000Z`);
      expect(parseSchedule(after.schedule)).toMatchObject({ startAt: `${WINTER}T17:00:00.000Z`, zone: LOS_ANGELES });

      // Keep the new times: nothing moves, and it is not raised again.
      const accepted = await press(takes.id, { intent: "keep-shown-time", zone: LOS_ANGELES });
      expect(accepted.ok, accepted.message).toBe(true);
      const unchanged = await named(shopId, "Takes 6 AM");
      expect(unchanged.startAt?.toISOString()).toBe(takes.startAt?.toISOString());
      expect(zoneOf(unchanged)).toBe(LOS_ANGELES);

      expect((await home()).zoneShifts, "a settled campaign was raised again").toEqual([]);
      expect((await campaignPage(keeps.id)).zoneShift).toBeNull();

      // The newest: the fixture's UTC was corrected to New York by the first create.
      const change = await prisma.auditLogEntry.findFirstOrThrow({
        where: { shopId, action: "settings.timezone" },
        orderBy: { createdAt: "desc" },
      });
      expect(change.before).toEqual({ timezone: NEW_YORK });
      expect(change.after).toMatchObject({ timezone: LOS_ANGELES });
      expect(change.actor).toBe("staff:42");
    });
  });

  it("flags a campaign saved before the zone was recorded, on a store Anchor still had as UTC", async () => {
    await withChaos("shop-timezone-legacy", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      signIn(chaos);
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC", initialSyncCompletedAt: null } });

      // As the editor saved it before #799: 9 AM read in the row's UTC, and no zone recorded.
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const startAt = `${WINTER}T09:00:00.000Z`;
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: "SCHEDULED",
          startAt: new Date(startAt),
          endAt: null,
          schedule: { ...(campaign.schedule as object), kind: "window", startAt } as never,
        },
      });
      expect(zoneOf(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } }))).toBeUndefined();

      chaos.fake.shopTimezone = NEW_YORK;
      await visit();
      await vi.waitFor(async () => expect(await storedZone(shopId)).toBe(NEW_YORK), { timeout: 5_000 });

      // The first visit read New York, and recorded that the campaign's 9 AM was UTC's.
      const stamped = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(zoneOf(stamped)).toBe("UTC");
      expect(stamped.startAt?.toISOString(), "a time moved by itself").toBe(startAt);
      const [told] = (await home()).zoneShifts;
      expect(told?.sentence).toMatch(/^Its times were set in UTC, and Shopify has your store in America\/New_York\. On your store's clock it starts 15 Jan \d{4}, 04:00, not 09:00\.$/);

      const kept = await press(campaignId, { intent: "keep-typed-time" });
      expect(kept.ok, kept.message).toBe(true);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).startAt?.toISOString()).toBe(
        `${WINTER}T14:00:00.000Z`,
      );
      expect((await home()).zoneShifts).toEqual([]);
    });
  });
});
