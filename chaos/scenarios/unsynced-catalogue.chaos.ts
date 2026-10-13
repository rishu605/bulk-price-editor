/**
 * A store Anchor has not read yet is told so, not told to loosen its conditions (#800).
 *
 * On anchor-perf, freshly installed and not yet synced, the editor said "No variant matches
 * every condition. Loosen one…" with every condition blank, the guided button waited with
 * no reason given, and the full editor created a campaign that could price nothing. The
 * preview and the create are driven here against the real database: the editor's own
 * action, with only `authenticate.admin` replaced.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { draftCampaignFrom } from "../../app/services/campaigns/draft-input.server";
import { previewDraft } from "../../app/services/campaigns/draft-preview.server";
import { withChaos } from "../harness/scenario";

let domain = "";
vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: domain }, sessionToken: { sub: "1" } }) },
}));

afterEach(() => vi.restoreAllMocks());

const draft = async (shopId: string, extra: Record<string, string> = {}) =>
  draftCampaignFrom(shopId, new URLSearchParams({ ruleKind: "percent-change", ruleValue: "-20", ...extra }), "USD");

async function create(name: string): Promise<unknown> {
  const { action } = await import("../../app/routes/app.campaigns.new");
  const body = new FormData();
  body.set("name", name);
  body.set("ruleKind", "percent-change");
  body.set("ruleValue", "-20");
  return action({ request: new Request("https://example.invalid/app/campaigns/new", { method: "POST", body }), params: {}, context: {} } as never).catch(
    (thrown: unknown) => thrown,
  );
}

describe("chaos: a store whose catalogue Anchor has not read", () => {
  it("says which: never read, being read, or read and empty -- and refuses to create a campaign that would price nothing", async () => {
    await withChaos("unsynced-catalogue", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      domain = chaos.fixture.domain;

      // The control: a catalogue, and conditions that match none of it, are the merchant's filter.
      const filtered = await previewDraft(shopId, await draft(shopId, { title: "no product is called this" }));
      expect(filtered.matched).toBe(0);
      expect(filtered.catalogue, "a real filter was blamed on the catalogue").toBeUndefined();

      // Freshly installed: nothing mirrored, no sync ever finished.
      await prisma.variantIndex.deleteMany({ where: { shopId } });
      await prisma.shop.update({ where: { id: shopId }, data: { initialSyncCompletedAt: null, syncStartedAt: null } });
      expect((await previewDraft(shopId, await draft(shopId))).catalogue).toBe("unsynced");

      await prisma.shop.update({ where: { id: shopId }, data: { syncStartedAt: new Date() } });
      expect((await previewDraft(shopId, await draft(shopId))).catalogue).toBe("syncing");

      // Creating one now is refused, saying why, and nothing is created.
      const before = await prisma.campaign.count({ where: { shopId } });
      const refused = await create("Sale on an unread store");
      expect(JSON.stringify(refused)).toMatch(/Anchor is reading your catalogue, so this campaign would price nothing/);
      expect(await prisma.campaign.count({ where: { shopId } }), "a campaign was created that prices nothing").toBe(before);

      // Read, and the store has no products.
      await prisma.shop.update({ where: { id: shopId }, data: { syncStartedAt: null, initialSyncCompletedAt: new Date() } });
      expect((await previewDraft(shopId, await draft(shopId))).catalogue).toBe("empty");
    });
  });
});
