/**
 * The plan meter counts what a campaign can cover, as the plan gate does (#1075).
 *
 * `planUsage` counted every variant row the shop had, deleted and gift card alike, while
 * every campaign scope compiles through `astToWhere`, which leaves both out. Live on
 * `dartmode-labs` Settings → Plan said 3,669 variants and a whole-catalogue campaign
 * covered 3,665: the four were gift cards. A shop near its limit could be told it could
 * exceed it by variants it had deleted, which no campaign would ever count.
 *
 * And the gate's other half: a run on a list of variants counted the list, so a list
 * holding a deleted variant or a gift card was refused for variants it would never price,
 * on a plan the meter said no campaign could outgrow.
 *
 * Through Home's loader, the plan page's loader and the real run. Only
 * `authenticate.admin` is replaced; the plan page's subscription check fails on the empty
 * admin and keeps the stored plan, as it does when Shopify is unreachable.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { planUsage } from "../../app/services/plan-usage.server";
import { withChaos } from "../harness/scenario";

let signedIn = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: signedIn }, sessionToken: undefined, admin: {} }),
  },
}));

const page = (path: string) => ({ request: new Request(`https://example.invalid${path}`), params: {}, context: {} }) as never;

async function homeUsage() {
  const { loader } = await import("../../app/routes/app._index");
  return ((await loader(page("/app"))) as unknown as { usage: { headline: string; detail: string; attention: boolean } }).usage;
}

async function planPage() {
  const { loader } = await import("../../app/routes/app.settings.plan");
  return (await loader(page("/app/settings/plan"))) as unknown as { variants: number; giftCards: number };
}

describe("chaos: the plan meter and the plan gate", () => {
  it("count neither deleted variants nor gift cards, on Home, on Settings → Plan and when a run starts", async () => {
    await withChaos("plan-meter-coverable", { catalog: { products: 7, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      signedIn = domain;

      // Seven rows: one deleted, one deleted gift card, two gift cards, three a campaign can price.
      const [deleted, deletedGiftCard, giftA, giftB, ...live] = variantGids;
      const mark = (gids: string[], data: { deletedAt?: Date; isGiftCard?: boolean }) =>
        prisma.variantIndex.updateMany({ where: { shopId, variantGid: { in: gids } }, data });
      await mark([deleted, deletedGiftCard], { deletedAt: new Date() });
      await mark([deletedGiftCard, giftA, giftB], { isGiftCard: true });
      expect(live).toHaveLength(3);

      await prisma.shop.update({ where: { id: shopId }, data: { planTier: "FREE", subscriptionStatus: "CANCELLED" } });
      const { PLANS } = await import("../../app/lib/billing/plans");
      const original = PLANS.free.variantLimit;

      try {
        // A limit the three live variants exactly fill. Seven rows, five live ones, or four
        // non-gift-card ones would each say the catalogue could outgrow it.
        PLANS.free.variantLimit = 3;

        expect(await planUsage(shopId)).toMatchObject({ catalogueVariants: 3, giftCards: 2, couldExceed: false });
        expect(await homeUsage()).toEqual({
          headline: "Free · campaigns up to 3 variants",
          detail: "Your whole catalogue is 3 variants, so no campaign can reach the limit. 2 gift cards are not counted: no campaign prices a gift card.",
          attention: false,
        });
        expect(await planPage()).toMatchObject({ variants: 3, giftCards: 2 });

        // The gate agrees. The whole campaign is the three it prices...
        const whole = await chaos.apply();
        expect(whole.refused, whole.messages.join(" ")).toBeUndefined();
        expect(whole.verified).toBe(3);
        await chaos.expectHonest(whole.runId);

        // ...and so is a run on a list of every row, deleted and gift card included, as an
        // enrolment can hold a variant deleted after it was listed. It was counted as seven.
        const subset = await chaos.apply({ variantGids });
        expect(subset.refused, subset.messages.join(" ")).toBeUndefined();
        await chaos.expectHonest(subset.runId);

        // One under, and the meter and both runs say so.
        PLANS.free.variantLimit = 2;
        expect(await homeUsage()).toMatchObject({ attention: true, detail: expect.stringContaining("Your catalogue is 3 variants") });
        for (const over of [await chaos.apply(), await chaos.apply({ variantGids })]) {
          expect(over.refused).toMatch(/\b2\b/);
          expect(over.verified).toBe(0);
        }
      } finally {
        PLANS.free.variantLimit = original;
      }

      // Reverting is never gated, and leaves the store where it was.
      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
    });
  });
});
