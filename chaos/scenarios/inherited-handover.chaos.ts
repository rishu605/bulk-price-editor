/**
 * A variant a sale inherits when a higher sale ends is that sale's, to drift detection and
 * to its own revert (#998).
 *
 * B (priority 200) prices one variant over A (priority 100). B ends, and its revert writes
 * A's price there -- `resolve(without B)`, rule 6 -- ledgered under B's revert, which held
 * the claim. A never wrote the variant, so before this:
 *
 *  - a hand edit to it found no campaign: no drift event, no hold, and A's revert later
 *    wrote over the edit without asking;
 *  - A's whole revert took back only what A wrote, so once the product left A's scope
 *    (archived, #751) A's price stayed on it after A ended.
 *
 * B is applied first, so A's own apply never writes the variant: the ledger has nothing of
 * A's there at all. Edits and the archive arrive through the products webhook, as
 * `drift-resolution.chaos.ts` drives it; runs are the real `runCampaign`.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { format } from "../../app/lib/money/format";
import { money } from "../../app/lib/money/money";
import { pricesWrittenBy } from "../../app/services/campaigns/candidates.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { inheritedBy, revertTakesBack } from "../../app/services/campaigns/handover.server";
import { rollbackReport } from "../../app/services/campaigns/rollback-report.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { revertVariant } from "../../app/services/campaigns/variant-revert.server";
import { enrollNewVariants } from "../../app/services/auto-enroll.server";
import { checkForDrift } from "../../app/services/drift.server";
import { reconcile, staleBaselineCount, staleBaselineVariants, uncontrolledAmong } from "../../app/services/reconciliation.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending: { shop: string; topic: string; payload: unknown; admin?: unknown } = { shop: "", topic: "", payload: {} };

vi.mock("../../app/shopify.server", () => ({
  authenticate: { webhook: async () => pending },
}));

// No worker queue, so the route handles each delivery in the request -- its fallback, and
// the same `processProductsWebhook` the worker drains with (#811). REDIS_URL is set in CI's
// chaos job, so without this the route would hand the delivery to a queue nothing here
// consumes. The queued path itself is `webhook-queue.chaos.ts`'s.
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => null,
}));

const webhookAdmin = {
  async graphql(_query: string, options?: { variables?: Record<string, unknown> }) {
    return { json: async () => ({ data: { product: { id: options?.variables?.id, isGiftCard: false } } }) };
  },
};

let clock = 60_000;

/** The products webhook for a change made in the Shopify admin: the store changes first. */
async function inShopify(chaos: ChaosContext, variantGid: string, change: { price?: string; status?: string }) {
  const variant = chaos.fake.variants.get(variantGid)!;
  if (change.price) variant.price = change.price;
  clock += 60_000;
  pending = {
    shop: chaos.fixture.domain,
    topic: "PRODUCTS_UPDATE",
    admin: webhookAdmin,
    payload: {
      admin_graphql_api_id: chaos.fixture.productOf.get(variantGid)!,
      title: "Inherited product",
      status: change.status ?? "active",
      // What the product carries: A's tag, and the one B selected it by.
      tags: "chaos, chaos-b",
      updated_at: new Date(Date.now() + clock).toISOString(),
      variants: [{ admin_graphql_api_id: variantGid, title: "V", price: variant.price, compare_at_price: null }],
      variant_gids: [{ admin_graphql_api_id: variantGid }],
    },
  };
  const { action } = await import("../../app/routes/webhooks.products");
  await action({ request: new Request("https://example.invalid/webhooks/products", { method: "POST" }) } as never);
}

const dollars = (minor: number) => (minor / 100).toFixed(2);

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

/** A sale at `priority` over the first of A's variants only, selected by its own tag. */
async function saleOverFirst(chaos: ChaosContext, name: string, priority: number, percent: number) {
  const { shopId, variantGids } = chaos.fixture;
  await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[0] }, data: { tags: ["chaos", "chaos-b"] } });
  return createCampaign(shopId, {
    name,
    priority,
    rule: { kind: "percent-change", percent },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: "chaos-b" }] }] },
    schedule: { kind: "manual" },
  } as never);
}

/**
 * B over A, then B ends: the first variant goes to A by B's revert, and A has never written
 * it. Returns B, and the price A holds there.
 */
async function handedToA(chaos: ChaosContext) {
  const { shopId, campaignId: a, variantGids, baseline } = chaos.fixture;
  const client = chaosAdminClient(chaos.server.endpoint());
  const [inherited] = variantGids;
  await prisma.campaign.update({ where: { id: a }, data: { priority: 100 } });

  const b = await saleOverFirst(chaos, "chaos/higher-sale", 200, -30);
  expect((await runCampaign(shopId, b.id, client, { actor: "chaos", verifySampleRate: 1 })).clean).toBe(true);
  await chaos.expectHonest((await chaos.apply()).runId);
  expect(chaos.fake.priceOf(inherited), "A wrote under B").toBe(dollars(Math.round(baseline.get(inherited)! * 0.7)));

  expect((await runCampaign(shopId, b.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 })).clean).toBe(true);
  const price = Math.round(baseline.get(inherited)! * 0.9);
  expect(chaos.fake.priceOf(inherited), "B's revert did not hand the variant to A").toBe(dollars(price));

  // The premise: nothing in A's ledger says A prices it.
  const ofA = await prisma.variantChange.count({ where: { shopId, variantGid: inherited, run: { campaignId: a } } });
  expect(ofA, "A wrote the variant itself; the scenario no longer tests a handover").toBe(0);
  return { b, price };
}

describe("chaos: a variant a sale inherited from a higher sale's end (#998)", () => {
  it("is A's drift when edited by hand: an event against A, and A held", async () => {
    await withChaos("inherited-drift", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: a, variantGids } = chaos.fixture;
      const [inherited] = variantGids;
      const { b, price } = await handedToA(chaos);
      expect(await statusOf(a)).toBe("ACTIVE");

      // Not while A is still being applied, as for a variant A wrote itself (#878): a
      // campaign whose run is writing is not yet keeping its prices.
      await prisma.campaign.update({ where: { id: a }, data: { status: "APPLYING" } });
      expect(await checkForDrift(shopId, inherited, 111n, null), "drift held a campaign still applying").toBe(false);
      await prisma.campaign.update({ where: { id: a }, data: { status: "ACTIVE" } });

      await inShopify(chaos, inherited, { price: "1.23" });

      const event = await prisma.driftEvent.findFirst({ where: { shopId, variantGid: inherited, resolution: "PENDING" } });
      expect(event, "a hand edit on an inherited variant raised no drift event").not.toBeNull();
      expect(event!.campaignId, "the edit was put on the campaign whose revert handed it over").toBe(a);
      expect(event!.campaignId).not.toBe(b.id);
      expect(Number(event!.expectedPrice)).toBe(price);
      expect(Number(event!.observedPrice)).toBe(123);
      expect(await statusOf(a), "A kept running over an edit to a price it holds").toBe("HELD");

      // A second edit while held is the same question, still A's.
      await inShopify(chaos, inherited, { price: "1.45" });
      const events = await prisma.driftEvent.findMany({ where: { shopId, variantGid: inherited, resolution: "PENDING" } });
      expect(events.map((e) => [e.campaignId, Number(e.observedPrice)])).toEqual([[a, 145]]);

      // And A's revert asks about it rather than rewriting it unasked.
      const report = await rollbackReport(shopId, a);
      const row = report.rows.find((r) => r.variantGid === inherited);
      expect(row?.kind, "A's rollback report does not ask about the edit").toBe("drifted");
      expect(row?.applied).toBe(format(money(price, "USD")));
      expect(report.straightforward).toBe(false);

      // Leaving the edit, A's revert ends the sale everywhere else and keeps it.
      const reverted = await chaos.revert({ skipVariantGids: [inherited], skipReason: "kept the merchant's edit" });
      await chaos.expectHonest(reverted.runId);
      expect(chaos.fake.priceOf(inherited), "A's revert wrote over a kept edit").toBe("1.45");
    });
  });

  it("is taken back by A's revert after its product leaves A's scope", async () => {
    await withChaos("inherited-archived", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: a, variantGids, baseline } = chaos.fixture;
      const [inherited] = variantGids;
      const { price } = await handedToA(chaos);

      // Archived in Shopify, price untouched: out of A's scope (#751), A's price still live.
      await inShopify(chaos, inherited, { status: "archived" });
      const status = await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid: inherited }, select: { status: true } });
      expect(status.status).toBe("ARCHIVED");
      expect(chaos.fake.priceOf(inherited)).toBe(dollars(price));
      expect(await prisma.driftEvent.count({ where: { shopId } }), "an archive is not an edit").toBe(0);

      // What A wrote does not include it; what A's revert takes back does.
      expect(await pricesWrittenBy(shopId, a)).not.toContain(inherited);
      expect(await revertTakesBack(shopId, a)).toContain(inherited);
      expect(Number((await inheritedBy(shopId, a)).get(inherited))).toBe(price);

      // Both previews of the revert say so.
      const baselineText = format(money(baseline.get(inherited)!, "USD"));
      const report = await rollbackReport(shopId, a);
      const row = report.rows.find((r) => r.variantGid === inherited);
      expect(row, "the rollback report leaves out a price the revert takes back").toBeDefined();
      expect(row!.kind).toBe("clean");
      expect(row!.revertsTo).toBe(baselineText);
      const confirmation = await previewCampaign(shopId, a, { revert: true, limit: 100 });
      expect(
        new Map(confirmation.rows.map((r) => [r.variantGid, r.after])).get(inherited),
        "the revert confirmation leaves out a price the revert takes back",
      ).toBe(baselineText);

      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
      expect(reverted.clean).toBe(true);
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid), `${gid} kept A's price after A ended`).toBe(dollars(baseline.get(gid)!));
      }
      // Ended: nothing is A's any more.
      expect(await revertTakesBack(shopId, a)).toEqual([]);
    });
  });

  it("is nobody's drift after a campaign lets the variant go and its baseline goes back", async () => {
    // The same lookup, the other way: "Revert this variant" is a revert's write too, and the
    // campaign that just let the variant go is not the one pricing it. The old lookup took
    // its newest row and held it for an edit to a price it had given up.
    await withChaos("inherited-let-go", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: a, variantGids, baseline } = chaos.fixture;
      const [letGo] = variantGids;
      await chaos.expectHonest((await chaos.apply()).runId);

      const outcome = await revertVariant(shopId, a, letGo, chaosAdminClient(chaos.server.endpoint()), { actor: "chaos" });
      expect(outcome.outcome?.clean).toBe(true);
      expect(chaos.fake.priceOf(letGo)).toBe(dollars(baseline.get(letGo)!));

      await inShopify(chaos, letGo, { price: "3.21" });
      expect(await prisma.driftEvent.count({ where: { shopId } }), "an edit to a variant A let go was taken for A's drift").toBe(0);
      expect(await statusOf(a)).toBe("ACTIVE");
    });
  });

  it("stops being A's once a later sale writes over it", async () => {
    await withChaos("inherited-taken-again", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId: a, variantGids, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const [inherited] = variantGids;
      await handedToA(chaos);
      expect([...(await inheritedBy(shopId, a)).keys()]).toEqual([inherited]);

      // C, at higher priority, takes the variant over and writes its own price. B's revert
      // is no longer the newest write there, so what it wrote says nothing about now.
      const c = await saleOverFirst(chaos, "chaos/later-sale", 300, -20);
      const applied = await runCampaign(shopId, c.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(applied.clean).toBe(true);
      expect(chaos.fake.priceOf(inherited)).toBe(dollars(Math.round(baseline.get(inherited)! * 0.8)));
      expect(await inheritedBy(shopId, a), "A still claims a variant C wrote over").toEqual(new Map());

      await inShopify(chaos, inherited, { price: "2.34" });
      const event = await prisma.driftEvent.findFirstOrThrow({ where: { shopId, variantGid: inherited, resolution: "PENDING" } });
      expect(event.campaignId, "the edit went to A, whose price C wrote over").toBe(c.id);
      expect(await statusOf(a)).toBe("ACTIVE");
      expect(await statusOf(c.id)).toBe("HELD");
    });
  });

  it("is credited to A on What's live, is not a price changed outside the app, and is not enrolled again (#1043)", async () => {
    await withChaos("inherited-readers", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, domain, campaignId: a, variantGids } = chaos.fixture;
      const [inherited] = variantGids;
      await handedToA(chaos);

      // What's live names the campaign the price is because of, and A's filter finds it.
      const page = await reconcile(shopId, domain, { priceListGid: "" });
      const row = page.rows.find((r) => r.variantGid === inherited);
      expect(row?.campaignId, "What's live credits an inherited price to nobody").toBe(a);
      expect(row?.drifted).toBe(false);
      const ofA = await reconcile(shopId, domain, { priceListGid: "", campaignId: a });
      expect(ofA.rows.map((r) => r.variantGid), "filtering What's live by A leaves out the price it inherited").toContain(inherited);

      // Not "changed outside a campaign": a stale-baseline recapture would make A's sale
      // price the variant's baseline, and A's revert would then write the sale back.
      expect(await staleBaselineVariants(shopId), "an inherited sale price reads as changed outside the app").not.toContain(inherited);
      expect(await staleBaselineCount(shopId)).toBe(0);
      expect(await uncontrolledAmong(shopId, [inherited]), "the previews count an inherited price as uncontrolled").toBe(0);
      expect(page.counts.staleBaseline).toBe(0);

      // A products webhook for it does not enrol it into A, which already prices it.
      await prisma.campaign.update({ where: { id: a }, data: { autoEnroll: true } });
      const enrolled = await enrollNewVariants(shopId, [inherited]);
      expect(enrolled.flatMap((result) => result.variantGids), "an inherited variant looked new to auto-enrol").toEqual([]);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: a } })).enrollPendingVariantGids).toEqual([]);
    });
  });
});
