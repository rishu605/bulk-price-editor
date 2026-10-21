/**
 * A resumed run tags what an earlier attempt priced but never tagged (#926).
 *
 * Tags come after prices. A resume leaves out every variant the earlier attempt already
 * priced, so a product whose price landed and whose tag did not stayed on sale without its
 * badge for good -- and a revert that died before its tag step never handed the winning
 * campaign's badges to the products it had already put back. Tagging them again had its
 * own trap: this campaign's own earlier tags read as "already present", ledgered as the
 * merchant's and reported as "already on their products and left as they are".
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const has = (tags: string[], tag: string) => tags.some((t) => t.toLowerCase() === tag.toLowerCase());

describe("chaos: tags after a run that did not finish them", () => {
  it("a resume tags the products whose tags failed, and claims its own earlier tags as its own", async () => {
    await withChaos("resume-tags", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20, tagKit: ["SALE"] }, async (chaos) => {
      const productGids = [...new Set(chaos.fixture.productOf.values())];

      // Every price lands; the badge goes on two products and fails on the rest.
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("tagsAdd"), after: 2 }]);
      const first = await chaos.apply();
      chaos.heal();
      expect(first.verified).toBe(4);
      const untagged = productGids.filter((gid) => !has(chaos.fake.tagsOf(gid), "SALE"));
      expect(untagged.length, "the fault did not take").toBeGreaterThan(0);
      expect(untagged.length).toBeLessThan(productGids.length);

      const resumed = await chaos.apply({ actor: "chaos", resume: true });
      for (const gid of productGids) expect(has(chaos.fake.tagsOf(gid), "SALE"), `${gid} is on sale without its badge`).toBe(true);
      const claims = await prisma.tagChange.findMany({ where: { runId: resumed.runId } });
      for (const claim of claims) {
        expect(claim.alreadyPresent, "the campaign's own tag was recorded as the merchant's").toEqual([]);
        expect(claim.addedTags).toEqual(["SALE"]);
      }
      expect(resumed.messages.join("\n")).not.toMatch(/already on (their products|its product) and (were|was) left as/);
    });
  });

  it("a resumed revert hands every product to the winning campaign's badges, those already put back too", async () => {
    await withChaos("resume-tags-takeover", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -30 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const productGids = [...new Set(chaos.fixture.productOf.values())];
      const client = chaosAdminClient(chaos.server.endpoint());

      // A (the fixture, -30%) above B (-10%, badged CLEARANCE).
      await chaos.apply();
      const lower = await createCampaign(shopId, {
        name: "chaos/resume-tags-takeover lower",
        priority: 100,
        rule: { kind: "percent-change", percent: -10 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        schedule: { kind: "manual" },
        tagKit: ["CLEARANCE"],
      });
      await runCampaign(shopId, lower.id, client, { actor: "chaos", verifySampleRate: 1 });

      // A's revert stops part-way: two prices back on B's sale, two still on A's.
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("productVariantsBulkUpdate"), after: 2 }]);
      await chaos.revert();
      chaos.heal();
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");

      // As if that attempt had died before its tag step: no badge handed over yet.
      for (const gid of productGids) {
        const product = chaos.fake.products.get(gid)!;
        product.tags = product.tags.filter((tag) => tag.toLowerCase() !== "clearance");
      }
      await prisma.tagChange.deleteMany({ where: { campaignId: lower.id } });

      await chaos.revert({ actor: "chaos", resume: true });
      for (const gid of productGids) {
        expect(has(chaos.fake.tagsOf(gid), "CLEARANCE"), `${gid} is on B's price without B's badge`).toBe(true);
      }
    });
  });
});
