/**
 * Home counts what the campaigns list shows, which leaves archived campaigns out (#723).
 *
 * Archiving is how a merchant says "I have dealt with this". Home still counted an archived
 * campaign that stopped part way -- "1 campaign stopped part way" -- and linked to a list
 * that said "Nothing here matches"; an archived draft was still offered as "Open the draft".
 *
 * And the other half: archiving does not end a campaign, so an archived one that is live is
 * still reported, apart from the tiles, rather than vanishing from "What is live right now".
 *
 * Through Home's own loader; only `authenticate.admin` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { listCampaigns } from "../../app/services/campaigns/list.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

async function home() {
  const { loader } = await import("../../app/routes/app._index");
  const data = (await loader({
    request: new Request("https://example.invalid/app"),
    params: {},
    context: {},
  } as never)) as unknown as Record<string, number>;
  return { running: data.live, needsAttention: data.needsAttention, drafts: data.drafts, archivedRunning: data.archivedRunning };
}

const archive = (id: string) => prisma.campaign.update({ where: { id }, data: { archivedAt: new Date() } });

describe("chaos: Home and archived campaigns", () => {
  it("counts neither an archived partial campaign nor an archived draft on a tile, and reports every archived one still running", async () => {
    await withChaos("home-archived", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId } = chaos.fixture;
      pending = { shop: domain };

      // A run that stops part way, and a draft beside it.
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("productVariantsBulkUpdate"), after: 1 }]);
      const run = await chaos.apply();
      chaos.heal();
      expect(run.clean).toBe(false);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");
      const draft = await createCampaign(shopId, {
        name: "chaos/home-archived draft",
        rule: { kind: "percent-change", percent: -10 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [] },
        schedule: { kind: "manual" },
      });

      expect(await home()).toMatchObject({ needsAttention: 1, drafts: 1 });

      await archive(campaignId);
      await archive(draft.id);
      // Off the tiles, which link to a list that hides archived campaigns. But a partial one
      // may have prices live, so it is in the archived-and-running line, which links to the
      // list's own "live or scheduled" view of exactly those (#1163).
      expect(await home(), "Home counted campaigns the list it links to hides").toMatchObject({
        needsAttention: 0,
        drafts: 0,
        running: 0,
        archivedRunning: 1,
      });

      // Each state the list's banner counts, and the same number (#1163): Home counted only
      // Active and Applying, so a held or scheduled one was missing here and there.
      const listCount = async () => (await listCampaigns(shopId, { q: "", status: "", archived: false, page: 1 })).archivedRunning;
      for (const status of ["ACTIVE", "HELD", "SCHEDULED"] as const) {
        await prisma.campaign.update({ where: { id: campaignId }, data: { status } });
        expect(await home(), status).toMatchObject({ running: 0, archivedRunning: 1 });
        expect(await listCount(), status).toBe(1);
      }
    });
  });
});
