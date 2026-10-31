/**
 * Archiving a live or scheduled campaign files it away and leaves it running, and says so (#748).
 *
 * "Sale · 21/09/2026", Active on DartMode Labs, was archived from More actions in one click:
 * nothing asked, and it left the campaigns list and its Active filter with its prices live. A
 * scheduled "Black Friday 2026" archived in October would still go live on 27 Nov, from a list
 * that no longer showed it.
 *
 * Archiving stays allowed (D18). Driven through the campaign page's own loader and action, the
 * campaigns index's loader and the real `tick`: the page says what archiving leaves running
 * before the press; the archived campaign still starts on its date and still ends at its end;
 * and from the press to its end the index counts it and lists it where the count links. Only
 * `authenticate.admin` and `adminClientForShop` are replaced, with clients for the fake store.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { formatScheduleInstant } from "../../app/lib/scheduling/window";
import { tick } from "../../app/services/scheduler.server";
import { chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";

const ZONE = "America/New_York";
let pending = { shop: "", endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: chaosAdminContext(pending.endpoint) }),
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

/** What the campaign page's Archive would say before it files the campaign away. */
async function archiving(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  const page = (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as { archiving: { keeps: string; instead: string | null } | null };
  return page.archiving;
}

/** The campaigns index, as its loader hands it to the list. */
async function index(query = "") {
  const { loader } = await import("../../app/routes/app.campaigns._index");
  const data = (await loader({
    request: new Request(`https://example.invalid/app/campaigns?${query}`),
    params: {},
    context: {},
  } as never)) as { list: { campaigns: Array<{ id: string; state: string; archived: boolean }>; archivedRunning: number } };
  return data.list;
}

/** The fixture shop in New York, so every date the page says is in the store's zone. */
async function useShop(chaos: ChaosContext) {
  pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
  await prisma.shop.update({ where: { id: chaos.fixture.shopId }, data: { timezone: ZONE } });
}

/** The fixture campaign with a window, as the editor stores one, in `status`. */
async function windowed(campaignId: string, startAt: Date, endAt: Date, status?: "SCHEDULED") {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      ...(status ? { status } : {}),
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
const salePrice = (minor: number) => (Math.round(minor * 0.8) / 100).toFixed(2);
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe("chaos: archiving a campaign that is still running (#748)", () => {
  it("says a scheduled campaign will still start, starts and ends it on its dates archived, and the list accounts for it throughout", async () => {
    await withChaos("archive-scheduled", CATALOG, async (chaos) => {
      const { campaignId, variantGids, baseline } = chaos.fixture;
      await useShop(chaos);

      // A draft has nothing running: Archive files it in one click, as before.
      expect(await archiving(campaignId)).toBeNull();

      // Black Friday, scheduled weeks out.
      const startAt = new Date(Date.now() + 27 * DAY);
      await windowed(campaignId, startAt, new Date(startAt.getTime() + DAY), "SCHEDULED");
      expect((await archiving(campaignId))?.keeps).toBe(
        `It will still start ${formatScheduleInstant(startAt.toISOString(), ZONE)} (${ZONE}), and its prices go live then.`,
      );

      const filed = await press(campaignId, { intent: "archive" });
      expect(filed.ok, filed.message).toBe(true);
      expect((await record(campaignId)).status, "archiving changed the lifecycle").toBe("SCHEDULED");

      // Out of the list, and counted by it, wherever it is filtered; linked to exactly it.
      const list = await index();
      expect(ids(list.campaigns)).not.toContain(campaignId);
      expect(list.archivedRunning).toBe(1);
      expect((await index("status=DRAFT&q=nothing")).archivedRunning, "a filter hid the count").toBe(1);
      expect(ids((await index("archived=1&status=live")).campaigns)).toEqual([campaignId]);

      // Its start comes. The scheduler starts it, archived as it is.
      await windowed(campaignId, new Date(Date.now() - MINUTE), new Date(Date.now() + DAY));
      await tick(new Date());
      const started = await record(campaignId);
      expect(started.status, "an archived scheduled campaign did not start").toBe("ACTIVE");
      expect(started.archivedAt).not.toBeNull();
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(salePrice(baseline.get(gid)!));
      expect((await index()).archivedRunning).toBe(1);
      expect((await index("archived=1&status=live")).campaigns).toEqual([
        expect.objectContaining({ id: campaignId, state: "ACTIVE", archived: true }),
      ]);

      // Its end comes. The scheduler ends it, archived as it is, and the count lets it go.
      await windowed(campaignId, new Date(Date.now() - DAY), new Date(Date.now() - MINUTE));
      await tick(new Date());
      expect((await record(campaignId)).status, "an archived live campaign was not ended on its end").toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
      expect((await index()).archivedRunning).toBe(0);
      expect((await index("archived=1&status=live")).campaigns).toEqual([]);
      expect(ids((await index("archived=1")).campaigns), "the finished campaign left the archive").toEqual([campaignId]);
    });
  });

  it("says an active campaign's prices stay live, keeps them live archived, and counts it until it is reverted", async () => {
    await withChaos("archive-active", CATALOG, async (chaos) => {
      const { campaignId, variantGids, baseline } = chaos.fixture;
      await useShop(chaos);
      await chaos.expectHonest((await chaos.apply()).runId);
      expect((await record(campaignId)).status).toBe("ACTIVE");

      // Applied by hand, with no end: nothing ends it but a revert.
      expect(await archiving(campaignId)).toEqual({
        keeps: "Its prices stay live on your storefront. It runs until you revert it.",
        instead: "To take its prices down, revert it instead.",
      });

      const filed = await press(campaignId, { intent: "archive" });
      expect(filed.ok, filed.message).toBe(true);
      await tick(new Date());
      expect((await record(campaignId)).status).toBe("ACTIVE");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(salePrice(baseline.get(gid)!));
      expect(ids((await index("status=ACTIVE")).campaigns), "the Active filter shows what it files away").not.toContain(campaignId);
      expect((await index("status=ACTIVE")).archivedRunning).toBe(1);

      // Reverted from its page, archived: its prices come down and the count lets it go.
      const reverted = await press(campaignId, { intent: "revert" });
      expect(reverted.ok, reverted.message).toBe(true);
      expect((await record(campaignId)).status).toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
      expect((await index()).archivedRunning).toBe(0);

      // Restore asks nothing and puts it back.
      const restored = await press(campaignId, { intent: "unarchive" });
      expect(restored.ok, restored.message).toBe(true);
      expect(ids((await index()).campaigns)).toContain(campaignId);
    });
  });
});
