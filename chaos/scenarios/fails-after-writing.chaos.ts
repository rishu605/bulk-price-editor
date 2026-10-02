/**
 * A run that fails after writing prices is Partial, never handed back as if nothing ran (#802).
 *
 * On anchor-perf a 102,132-variant apply wrote and verified 55,000 prices, then timed out
 * waiting for a database connection while recording the rest. The catch marked the run
 * failed, then gave the claim back to where it came from: Draft, "Nothing has been written
 * to your storefront", over 54,168 prices at 10% off that nothing owned -- and Revert does
 * not work on a draft. The run read "Failed · 0 verified", and the merchant was told
 * "Nothing was changed in your store".
 *
 * The same timeout here: the ledger's update throws Prisma's P2024 at the moment the run
 * records its failed rows, after the verified ones are recorded. One product's write is
 * made to fail so there are failed rows to record.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { AppError } from "../../app/lib/errors/app-error";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

let throwBeforeWriting = false;

vi.mock("../../app/services/campaigns/market-surfaces.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/campaigns/market-surfaces.server")>();
  return {
    ...actual,
    captureMarketBaselinesFirst: async (...args: Parameters<typeof actual.captureMarketBaselinesFirst>) => {
      if (throwBeforeWriting) throw Object.assign(new Error("Timed out fetching a new connection from the connection pool"), { code: "P2024" });
      return actual.captureMarketBaselinesFirst(...args);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  throwBeforeWriting = false;
});

const statusOf = async (id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

describe("chaos: the database gives out after prices are written", () => {
  it("leaves the campaign Partial with what landed, says prices changed, and Revert puts them back", async () => {
    await withChaos("fails-after-writing", { catalog: { products: 6, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids, productOf, baseline } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      expect(await statusOf(campaignId)).toBe("DRAFT");

      // The last product's write fails, so the run has failed rows to record after its
      // verified ones -- the ledger is written in row order.
      chaos.arm([{ fault: "server-error", match: (query, variables) => isVariantWrite(query) && variables.productId === productOf.get(variantGids[5]) }]);
      const updateMany = prisma.variantChange.updateMany.bind(prisma.variantChange);
      vi.spyOn(prisma.variantChange, "updateMany").mockImplementation(((args: { data?: { status?: string } }) => {
        if (args.data?.status === "FAILED") {
          throw Object.assign(new Error("Timed out fetching a new connection from the connection pool"), { code: "P2024" });
        }
        return updateMany(args as never);
      }) as never);

      const thrown = await runCampaign(shopId, campaignId, client).catch((error: unknown) => error);
      vi.restoreAllMocks();
      chaos.heal();

      expect(thrown).toBeInstanceOf(AppError);
      const error = thrown as AppError;
      expect(error.code, "the failure's own code is kept, for Flow and the worker").toBe("DB_UNAVAILABLE");
      expect(error.userMessage, "told nothing changed over prices that had").not.toMatch(/Nothing was changed/);
      expect(error.userMessage).toMatch(/^This apply stopped part-way\. 5 of 6 prices were changed before it did/);
      expect(error.userMessage).toMatch(/The campaign is now Partial: Resume to finish the apply, or Revert to put every price back\./);

      expect(await statusOf(campaignId), "handed back to Draft over live sale prices").toBe("PARTIAL");
      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId } });
      expect(run.status).toBe("PARTIAL");
      expect(run.verifiedRows, "the run read '0 verified' over a ledger of verified rows").toBe(5);
      const transition = await prisma.auditLogEntry.findFirstOrThrow({
        where: { shopId, entityId: campaignId, action: "campaign.transition" },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(transition.after)).toMatch(/apply stopped part-way, after 5 of 6 prices were changed and read back/);
      expect(JSON.stringify(transition.after)).not.toMatch(/without running/);

      // The way back works: revert from Partial ends every price at its baseline.
      const reverted = await runCampaign(shopId, campaignId, client, { revert: true });
      expect(reverted.clean).toBe(true);
      expect(await statusOf(campaignId)).toBe("COMPLETED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
    });
  });

  it("still hands the campaign back, saying nothing changed, when nothing was sent", async () => {
    await withChaos("fails-before-writing", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const before = new Map(variantGids.map((gid) => [gid, chaos.fake.priceOf(gid)]));
      throwBeforeWriting = true;

      const thrown = await runCampaign(shopId, campaignId, chaosAdminClient(chaos.server.endpoint())).catch((error: unknown) => error);

      expect((thrown as Error).message).toMatch(/connection pool/);
      expect(await statusOf(campaignId), "nothing was written, so it goes back where it was").toBe("DRAFT");
      expect((await prisma.campaignRun.findFirstOrThrow({ where: { campaignId } })).status).toBe("FAILED");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(before.get(gid));
    });
  });
});
