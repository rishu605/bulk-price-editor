/**
 * Campaigns leave draft and archived products out unless the merchant opts in (#751).
 *
 * Found on a live store: a QA campaign scoped "Title contains Alpine Snowboard 0" applied
 * to both variants, "all verified" -- and Alpine Snowboard 0 was archived. It was repriced
 * and given the campaign's storefront tag. Every scope, "All variants" and Home's "Put
 * everything on sale" included, covered draft and archived products, and nothing in the
 * editor could leave them out.
 *
 * Through the real engine against a real database, on four products: two active, one draft,
 * one archived. Each test is one claim:
 *
 *   An all-variants campaign prices and tags only the active two, and the editor's preview
 *   said so -- the same scope, counted the same way, with the other two named as left out.
 *
 *   Ticking both boxes reaches all four, and the preview said that too.
 *
 *   A campaign whose scope stopped covering a variant it wrote -- every campaign made before
 *   #751 that reached a draft, or any sale whose product is archived mid-way -- still takes
 *   that price back on revert, and both revert previews say so rather than claiming it
 *   "reverts to" its sale price.
 *
 *   Home's card counts what its campaign prices, and the campaign it makes prices that.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { format } from "../../app/lib/money/format";
import { money } from "../../app/lib/money/money";
import { draftCampaignFrom } from "../../app/services/campaigns/draft-input.server";
import { previewDraft } from "../../app/services/campaigns/draft-preview.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { rollbackReport } from "../../app/services/campaigns/rollback-report.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { scopeSize } from "../../app/services/campaigns/scope-size.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";
import { redefine } from "../harness/definition";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

const TAG = "SALE-751";
const SPEC = { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20, tagKit: [TAG] };

const has = (tags: string[], tag: string) => tags.some((t) => t.toLowerCase() === tag.toLowerCase());

/** Two active products, then a draft, then an archived one -- in the mirror, as a sync leaves them. */
async function withStatuses(chaos: ChaosContext) {
  const [active1, active2, draft, archived] = chaos.fixture.variantGids;
  await prisma.variantIndex.update({
    where: { shopId_variantGid: { shopId: chaos.fixture.shopId, variantGid: draft! } },
    data: { status: "DRAFT" },
  });
  await prisma.variantIndex.update({
    where: { shopId_variantGid: { shopId: chaos.fixture.shopId, variantGid: archived! } },
    data: { status: "ARCHIVED" },
  });
  return { active: [active1!, active2!], draft: draft!, archived: archived! };
}

/** An all-variants sale at 20% off, as the editor makes one from these fields. */
async function allVariantsSale(chaos: ChaosContext, fields: Record<string, string>) {
  const { shopId } = chaos.fixture;
  const params = new URLSearchParams({ ruleKind: "percent-change", ruleValue: "-20", compareAt: "leave", ...fields });
  const draft = await draftCampaignFrom(shopId, params, "USD");
  const preview = await previewDraft(shopId, draft, 100);
  const campaign = await createCampaign(shopId, {
    name: `chaos/product-status ${Object.keys(fields).join("+") || "default"}`,
    ast: draft.ast,
    rule: draft.rule,
    compareAtPolicy: draft.compareAtPolicy,
    rounding: { default: "none", byCurrency: {} },
    priority: 1000,
    tagKit: [TAG],
    schedule: { kind: "manual" },
  });
  return { preview, campaign };
}

describe("chaos: draft and archived products (#751)", () => {
  it("leaves them out of an all-variants campaign, and the preview says so", async () => {
    await withChaos("product-status", SPEC, async (chaos) => {
      const { shopId, baseline, productOf } = chaos.fixture;
      const { active, draft, archived } = await withStatuses(chaos);
      const client = chaosAdminClient(chaos.server.endpoint());
      const at = (gid: string, factor: number) => (Math.round(baseline.get(gid)! * factor) / 100).toFixed(2);

      const { preview, campaign } = await allVariantsSale(chaos, {});
      expect(preview.matched, "the preview counted the draft or the archived product").toBe(2);
      expect(preview.leftOutByStatus).toBe(2);
      expect(await scopeSize(shopId, campaign.id), "the campaign's scope differs from its preview's").toBe(2);

      const run = await runCampaign(shopId, campaign.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(run.verified).toBe(2);
      expect(chaos.fake.priceOf(active[0]!)).toBe(at(active[0]!, 0.8));
      expect(chaos.fake.priceOf(active[1]!)).toBe(at(active[1]!, 0.8));
      expect(chaos.fake.priceOf(draft), "a draft the merchant is preparing was repriced").toBe(at(draft, 1));
      expect(chaos.fake.priceOf(archived), "an archived product was repriced").toBe(at(archived, 1));

      expect(has(chaos.fake.tagsOf(productOf.get(active[0]!)!), TAG)).toBe(true);
      expect(has(chaos.fake.tagsOf(productOf.get(draft)!), TAG), "a draft was given the sale tag").toBe(false);
      expect(has(chaos.fake.tagsOf(productOf.get(archived)!), TAG), "an archived product was given the sale tag").toBe(false);

      const ledgered = await prisma.variantChange.findMany({ where: { runId: run.runId }, select: { variantGid: true } });
      expect(ledgered.map((row) => row.variantGid).sort()).toEqual([...active].sort());
    });
  });

  it("covers them when the merchant ticks both boxes, and the preview says that too", async () => {
    await withChaos("product-status-opt-in", SPEC, async (chaos) => {
      const { shopId, baseline, productOf } = chaos.fixture;
      const { draft, archived } = await withStatuses(chaos);
      const client = chaosAdminClient(chaos.server.endpoint());
      const at = (gid: string, factor: number) => (Math.round(baseline.get(gid)! * factor) / 100).toFixed(2);

      const { preview, campaign } = await allVariantsSale(chaos, { includeDraft: "1", includeArchived: "1" });
      expect(preview.matched).toBe(4);
      expect(preview.leftOutByStatus).toBe(0);

      const run = await runCampaign(shopId, campaign.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(run.verified).toBe(4);
      expect(chaos.fake.priceOf(draft)).toBe(at(draft, 0.8));
      expect(chaos.fake.priceOf(archived)).toBe(at(archived, 0.8));
      expect(has(chaos.fake.tagsOf(productOf.get(archived)!), TAG)).toBe(true);
    });
  });

  it("takes back what it wrote on a product its scope no longer covers, and its revert previews agree", async () => {
    await withChaos("product-status-strays", SPEC, async (chaos) => {
      const { shopId, baseline, productOf, variantGids } = chaos.fixture;
      const { draft, archived } = await withStatuses(chaos);
      const client = chaosAdminClient(chaos.server.endpoint());
      const at = (gid: string, factor: number) => (Math.round(baseline.get(gid)! * factor) / 100).toFixed(2);
      const usd = (gid: string) => format(money(baseline.get(gid)!, "USD"));

      // A campaign that reached all four, then stopped covering two of them: what every
      // campaign made before #751 is now, having had no statuses recorded -- and what any
      // sale is when a product is archived half-way through it.
      const { campaign } = await allVariantsSale(chaos, { includeDraft: "1", includeArchived: "1" });
      await runCampaign(shopId, campaign.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(variantGids.map((gid) => chaos.fake.priceOf(gid))).toEqual(variantGids.map((gid) => at(gid, 0.8)));

      await redefine(campaign.id, { productStatuses: null });
      expect(await scopeSize(shopId, campaign.id), "a campaign with nothing recorded still covers the archive").toBe(2);

      // Both previews of the revert, planned from scope alone, said these two "revert to" the
      // sale price -- while the revert put their baselines back.
      const report = await rollbackReport(shopId, campaign.id);
      const revertsTo = new Map(report.rows.map((row) => [row.variantGid, row.revertsTo]));
      expect(revertsTo.get(draft), "the rollback report disagrees with the revert").toBe(usd(draft));
      expect(revertsTo.get(archived), "the rollback report disagrees with the revert").toBe(usd(archived));

      const confirmation = await previewCampaign(shopId, campaign.id, { revert: true, limit: 100 });
      const after = new Map(confirmation.rows.map((row) => [row.variantGid, row.after]));
      expect(after.get(draft), "the revert confirmation leaves out a price the revert takes back").toBe(usd(draft));
      expect(after.get(archived), "the revert confirmation leaves out a price the revert takes back").toBe(usd(archived));

      const revert = await runCampaign(shopId, campaign.id, client, { actor: "chaos", revert: true, verifySampleRate: 1 });
      expect(revert.clean).toBe(true);
      expect(variantGids.map((gid) => chaos.fake.priceOf(gid)), "a price stayed on sale after the sale ended").toEqual(
        variantGids.map((gid) => at(gid, 1)),
      );
      for (const gid of variantGids) {
        expect(has(chaos.fake.tagsOf(productOf.get(gid)!), TAG), `${gid} kept the sale tag`).toBe(false);
      }
    });
  });

  it("counts on Home what the quick campaign prices, and the campaign prices that", async () => {
    await withChaos("product-status-home", SPEC, async (chaos) => {
      const { shopId, domain, baseline } = chaos.fixture;
      const { active, draft, archived } = await withStatuses(chaos);
      const client = chaosAdminClient(chaos.server.endpoint());
      pending = { shop: domain };

      const { loader, action } = await import("../../app/routes/app._index");
      const home = (await loader({ request: new Request("https://example.invalid/app"), params: {}, context: {} } as never)) as {
        onSale: number;
      };
      expect(home.onSale, "Home promised a sale over products it should not touch").toBe(2);

      const body = new FormData();
      body.set("intent", "quick-campaign");
      body.set("percent", "20");
      const response = await action({
        request: new Request("https://example.invalid/app", { method: "POST", body }),
        params: {},
        context: {},
      } as never).catch((thrown: unknown) => thrown);
      expect(response instanceof Response && response.status, "quick create did not redirect to its draft").toBe(302);

      const quick = await prisma.campaign.findFirstOrThrow({
        where: { shopId, id: { not: chaos.fixture.campaignId } },
        orderBy: { createdAt: "desc" },
      });
      expect(await scopeSize(shopId, quick.id)).toBe(home.onSale);

      const run = await runCampaign(shopId, quick.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(run.verified).toBe(2);
      const untouched = [draft, archived].map((gid) => chaos.fake.priceOf(gid));
      expect(untouched).toEqual([draft, archived].map((gid) => (baseline.get(gid)! / 100).toFixed(2)));
      expect(active.map((gid) => chaos.fake.priceOf(gid))).toEqual(
        active.map((gid) => (Math.round(baseline.get(gid)! * 0.8) / 100).toFixed(2)),
      );
    });
  });
});
