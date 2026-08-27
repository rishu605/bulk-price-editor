/**
 * Drift holds the campaign that controls the variant, and no other.
 *
 * `checkForDrift` documents itself as narrow: "it means the price changed *while a
 * campaign controls the variant*. Outside a campaign a price change is just the merchant
 * running their store, and flagging that would make the queue useless noise."
 *
 * The implementation did not do that. It took any ACTIVE campaign on the shop, ordered by
 * priority, and never looked at the variant — so a merchant editing one product by hand
 * stopped whichever unrelated campaign happened to be running, and the drift event named
 * a variant that campaign had never priced. On a store running several campaigns at once,
 * which is the whole premise of this product, the highest-priority campaign absorbed every
 * hand edit in the catalogue.
 *
 * Found on a real store: a campaign was left HELD with no drift event to explain it,
 * because the campaign the event belonged to had been deleted and taken the event with it.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { checkForDrift } from "../../app/services/drift.server";
import { withChaos } from "../harness/scenario";

/** A VERIFIED ledger row is the record of us having priced this variant. */
async function recordPriced(
  shopId: string,
  campaignId: string,
  variantGid: string,
  price: bigint,
) {
  const run = await prisma.campaignRun.create({
    data: {
      shopId,
      campaignId,
      kind: "APPLY",
      status: "COMPLETED",
      occurrenceKey: `drift-scope-${campaignId}-${variantGid}`,
    },
  });

  await prisma.variantChange.create({
    data: {
      runId: run.id,
      shopId,
      variantGid,
      surfaceKind: "BASE",
      priceListGid: "",
      currency: "USD",
      beforePrice: price + 1000n,
      intendedPrice: price,
      status: "VERIFIED",
    },
  });
}

describe("chaos: drift holds only the campaign that priced the variant", () => {
  it("leaves an unrelated campaign alone when another product is edited by hand", async () => {
    await withChaos(
      "drift-scope",
      { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 },
      async (chaos) => {
        const shopId = chaos.fixture.shopId;
        const [ours, theirs] = chaos.fixture.variantGids;
        expect(theirs, "the fixture needs at least two variants").toBeDefined();

        // The campaign under test controls `ours` and nothing else. It is deliberately
        // the *lower* priority of the two, because the old query sorted by priority and
        // would have picked the other one.
        const mine = await prisma.campaign.update({
          where: { id: chaos.fixture.campaignId },
          data: { status: "ACTIVE", priority: 100 },
          select: { id: true },
        });
        await recordPriced(shopId, mine.id, ours!, 5000n);

        // A second, higher-priority campaign that has priced nothing at all.
        const bystander = await prisma.campaign.create({
          data: {
            shopId,
            name: "Bystander",
            status: "ACTIVE",
            priority: 999,
            ruleRows: [] as never,
            surfaces: { base: true, priceLists: [] } as never,
            compareAtPolicy: { kind: "leave" } as never,
            compareAtViolationPolicy: "clear",
            guardrails: {} as never,
            guardrailViolationPolicy: "clamp",
            schedule: { kind: "manual" } as never,
          },
          select: { id: true },
        });

        // Both variants need a surface entry, which is what "the price we last saw" means.
        for (const gid of [ours!, theirs!]) {
          await prisma.priceSurfaceEntry.upsert({
            where: {
              shopId_variantGid_surfaceKind_priceListGid: {
                shopId,
                variantGid: gid,
                surfaceKind: "BASE",
                priceListGid: "",
              },
            },
            create: {
              shopId,
              variantGid: gid,
              surfaceKind: "BASE",
              priceListGid: "",
              livePrice: 5000n,
              currency: "USD",
            },
            update: { livePrice: 5000n },
          });
        }

        // The merchant edits a variant NOTHING has priced.
        const flaggedOther = await checkForDrift(shopId, theirs!, 4200n, null);

        expect(flaggedOther, "an unpriced variant is the merchant running their store").toBe(
          false,
        );
        expect(
          (await prisma.campaign.findUniqueOrThrow({ where: { id: bystander.id } })).status,
          "the bystander priced nothing and must not be held",
        ).toBe("ACTIVE");
        expect(
          (await prisma.campaign.findUniqueOrThrow({ where: { id: mine.id } })).status,
          "this campaign does not cover that variant either",
        ).toBe("ACTIVE");

        // Now the merchant edits the variant this campaign actually priced.
        const flaggedOurs = await checkForDrift(shopId, ours!, 4200n, null);

        expect(flaggedOurs, "a variant under a campaign's control is real drift").toBe(true);
        expect(
          (await prisma.campaign.findUniqueOrThrow({ where: { id: mine.id } })).status,
          "the campaign that priced it is the one that stops",
        ).toBe("HELD");
        expect(
          (await prisma.campaign.findUniqueOrThrow({ where: { id: bystander.id } })).status,
          "the higher-priority bystander is still not involved",
        ).toBe("ACTIVE");

        const event = await prisma.driftEvent.findFirstOrThrow({
          where: { shopId, variantGid: ours! },
          select: { campaignId: true },
        });
        expect(event.campaignId, "the event names the campaign that priced it").toBe(mine.id);
      },
    );
  });
});
