/**
 * Auto-enrol never puts a sale back on what the merchant is ending (#805).
 *
 * On anchor-perf a revert of 10% off 102,132 variants died part-way. The campaign went back
 * to Active, the product webhooks of the revert's own writes enrolled a handful of
 * variants, and the scheduler's re-apply for them -- a whole-campaign run -- re-discounted
 * 11,956 and then 7,364 variants the revert had just restored. The storefront became a tug
 * of war between Shopify finishing the revert and the scheduler re-applying the sale.
 *
 * Driven through the real products webhook and the real scheduler tick. `authenticate.webhook`
 * is replaced (it needs an HMAC), and so is `adminClientForShop` (the fixture shop has no
 * Shopify session) with a client for the fake store.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { recordWriteIntents } from "../../app/services/drift.server";
import { tick } from "../../app/services/scheduler.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

interface FakeAdmin {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<{ json(): Promise<unknown> }>;
}

let pending: { shop: string; topic: string; payload: unknown; admin?: FakeAdmin } = { shop: "", topic: "", payload: {} };
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(endpoint) };
});

afterEach(() => vi.restoreAllMocks());

/** Shopify says every new product here is an ordinary one, not a gift card. */
const ordinary: FakeAdmin = {
  async graphql(query, options) {
    if (!query.includes("AnchorProductGiftCard")) throw new Error(`unexpected query: ${query}`);
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

let clock = Date.parse("2026-10-02T09:00:00.000Z");

/** One product webhook, each newer than the last, as Shopify would send it. */
async function deliver(shopDomain: string, topic: string, productGid: string, variants: Array<{ gid: string; price: string }>) {
  clock += 60_000;
  pending = {
    shop: shopDomain,
    topic,
    admin: ordinary,
    payload: {
      admin_graphql_api_id: productGid,
      title: "Webhook product",
      status: "active",
      vendor: "Acme",
      tags: "chaos",
      updated_at: new Date(clock).toISOString(),
      variants: variants.map((v) => ({ admin_graphql_api_id: v.gid, title: "M", price: v.price, inventory_quantity: 3 })),
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  return action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

const dollars = (minor: number) => (minor / 100).toFixed(2);

const campaignOf = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

const applyRuns = (campaignId: string) => prisma.campaignRun.count({ where: { campaignId, kind: "APPLY" } });

/** A product that joins the store mid-campaign, in scope, at its own price. */
function newcomer(fake: { addVariant(v: { variantGid: string; productGid: string; price: string; compareAtPrice: null }): void }, name: string, price: string) {
  const variantGid = `gid://shopify/ProductVariant/805-${name}`;
  const productGid = `gid://shopify/Product/805-${name}`;
  fake.addVariant({ variantGid, productGid, price, compareAtPrice: null });
  return { variantGid, productGid, price };
}

describe("chaos: auto-enrol and a campaign being ended", () => {
  it("never re-applies a campaign whose revert stopped part-way: not for its own echoes, not for a new product", async () => {
    await withChaos("auto-enrol-revert", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf, baseline } = chaos.fixture;
      endpoint = chaos.server.endpoint();
      const client = chaosAdminClient(endpoint);

      await chaos.expectHonest((await chaos.apply()).runId);

      // A product joins while the sale runs, and is enrolled -- the mark names it.
      const early = newcomer(chaos.fake, "early", "40.00");
      await deliver(domain, "PRODUCTS_CREATE", early.productGid, [{ gid: early.variantGid, price: early.price }]);
      expect((await campaignOf(campaignId)).enrollPendingVariantGids).toEqual([early.variantGid]);

      // The merchant reverts, and the revert dies part-way: the last product's write fails
      // and the database gives out recording it, after three prices were restored.
      const last = variantGids[3];
      chaos.arm([{ fault: "server-error", match: (query, variables) => isVariantWrite(query) && variables.productId === productOf.get(last) }]);
      const updateMany = prisma.variantChange.updateMany.bind(prisma.variantChange);
      vi.spyOn(prisma.variantChange, "updateMany").mockImplementation(((args: { data?: { status?: string } }) => {
        if (args.data?.status === "FAILED") {
          throw Object.assign(new Error("Timed out fetching a new connection from the connection pool"), { code: "P2024" });
        }
        return updateMany(args as never);
      }) as never);
      await expect(runCampaign(shopId, campaignId, client, { revert: true, verifySampleRate: 1 })).rejects.toThrow();
      vi.restoreAllMocks();
      chaos.heal();
      expect((await campaignOf(campaignId)).status).toBe("PARTIAL");

      // The revert's own writes echo back, and another product joins.
      for (const gid of variantGids.slice(0, 3)) {
        await deliver(domain, "PRODUCTS_UPDATE", productOf.get(gid)!, [{ gid, price: dollars(baseline.get(gid)!) }]);
      }
      const late = newcomer(chaos.fake, "late", "30.00");
      await deliver(domain, "PRODUCTS_CREATE", late.productGid, [{ gid: late.variantGid, price: late.price }]);
      expect((await campaignOf(campaignId)).enrollPendingVariantGids, "a campaign being reverted gained variants").not.toContain(late.variantGid);

      // The scheduler's next tick: the mark from before the revert is dropped, not priced.
      await tick(new Date());
      await tick(new Date());

      expect(await applyRuns(campaignId), "an apply started against the merchant's revert").toBe(1);
      const campaign = await campaignOf(campaignId);
      expect(campaign.enrollPendingAt).toBeNull();
      expect(campaign.enrollPendingVariantGids).toEqual([]);
      for (const gid of variantGids.slice(0, 3)) {
        expect(chaos.fake.priceOf(gid), "a restored price was discounted again").toBe(dollars(baseline.get(gid)!));
      }
      expect(chaos.fake.priceOf(early.variantGid)).toBe("40.00");
      expect(chaos.fake.priceOf(late.variantGid)).toBe("30.00");

      // And the campaign still says what happened: a revert that stopped part-way.
      expect(campaign.status).toBe("PARTIAL");
      const transition = await prisma.auditLogEntry.findFirstOrThrow({
        where: { shopId, entityId: campaignId, action: "campaign.transition" },
        orderBy: { createdAt: "desc" },
      });
      expect((transition.after as { reason: string }).reason).toMatch(/^revert stopped part-way/);
    });
  });

  it("prices the enrolled variants and nothing else", async () => {
    await withChaos("auto-enrol-scoped", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf, baseline } = chaos.fixture;
      endpoint = chaos.server.endpoint();

      await chaos.expectHonest((await chaos.apply()).runId);

      // One variant reads full price in the mirror and in the store. A whole-campaign
      // re-apply plans every in-scope variant from that mirror and puts the sale back on
      // it -- which, after a revert, is every variant the revert restored.
      const aside = variantGids[0];
      chaos.fake.addVariant({ variantGid: aside, productGid: productOf.get(aside)!, price: dollars(baseline.get(aside)!), compareAtPrice: null });
      await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid: aside }, data: { livePrice: BigInt(baseline.get(aside)!) } });
      const transitionsBefore = await prisma.auditLogEntry.count({ where: { shopId, entityId: campaignId, action: "campaign.transition" } });

      const joined = newcomer(chaos.fake, "joined", "50.00");
      await deliver(domain, "PRODUCTS_CREATE", joined.productGid, [{ gid: joined.variantGid, price: joined.price }]);
      expect((await campaignOf(campaignId)).enrollPendingVariantGids).toEqual([joined.variantGid]);

      await tick(new Date());

      expect(chaos.fake.priceOf(joined.variantGid), "the enrolled variant was not priced").toBe("40.00");
      expect(chaos.fake.priceOf(aside), "a variant nobody enrolled was rewritten").toBe(dollars(baseline.get(aside)!));

      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId }, orderBy: { createdAt: "desc" } });
      expect(run.occurrenceKey).toMatch(/^VARIANT-ENROLL-/);
      expect(run.status).toBe("COMPLETED");
      const rows = await prisma.variantChange.findMany({ where: { runId: run.id }, select: { variantGid: true, status: true } });
      expect(rows).toEqual([{ variantGid: joined.variantGid, status: "VERIFIED" }]);

      // A run over named variants never claims the campaign: no Applying, no Active again.
      const campaign = await campaignOf(campaignId);
      expect(campaign.status).toBe("ACTIVE");
      expect(campaign.enrollPendingAt).toBeNull();
      expect(await prisma.auditLogEntry.count({ where: { shopId, entityId: campaignId, action: "campaign.transition" } })).toBe(transitionsBefore);
    });
  });

  it("enrols a variant that entered the scope, not the echo of a write or one the campaign already planned", async () => {
    await withChaos("auto-enrol-new-only", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, productOf, baseline } = chaos.fixture;
      endpoint = chaos.server.endpoint();

      // The apply leaves one write failed: the campaign is Partial, and Resume is how that
      // variant gets its price -- not an enrolment on every edit to it.
      const failed = variantGids[2];
      chaos.arm([{ fault: "server-error", match: (query, variables) => isVariantWrite(query) && variables.productId === productOf.get(failed) }]);
      await chaos.apply();
      chaos.heal();
      expect((await campaignOf(campaignId)).status).toBe("PARTIAL");
      expect(await prisma.variantChange.count({ where: { variantGid: failed, status: "FAILED" } })).toBe(1);

      // The merchant edits that product -- stock, a title -- and its price is what it was.
      await deliver(domain, "PRODUCTS_UPDATE", productOf.get(failed)!, [{ gid: failed, price: dollars(baseline.get(failed)!) }]);
      expect((await campaignOf(campaignId)).enrollPendingAt, "a variant the apply already planned was enrolled").toBeNull();

      // A price Anchor wrote, echoing back -- for a variant this campaign has no row for,
      // as when another campaign or a scoped run wrote it.
      const echoed = newcomer(chaos.fake, "echoed", "24.00");
      await recordWriteIntents(shopId, [{ variantGid: echoed.variantGid, price: 2_400n, compareAt: "leave" }]);
      await deliver(domain, "PRODUCTS_CREATE", echoed.productGid, [{ gid: echoed.variantGid, price: "24.00" }]);
      expect((await campaignOf(campaignId)).enrollPendingAt, "Anchor's own write was enrolled").toBeNull();

      // The control: the same product, edited by the merchant, has genuinely entered.
      await deliver(domain, "PRODUCTS_UPDATE", echoed.productGid, [{ gid: echoed.variantGid, price: "25.00" }]);
      const campaign = await campaignOf(campaignId);
      expect(campaign.enrollPendingAt).not.toBeNull();
      expect(campaign.enrollPendingVariantGids).toEqual([echoed.variantGid]);
    });
  });
});
