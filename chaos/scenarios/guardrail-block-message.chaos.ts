/**
 * A campaign a blocking guardrail stops says which variants, why in words, and what to do
 * (#1076).
 *
 * It said "Blocked by a guardrail on gid://shopify/ProductVariant/46172975726826:
 * below-floor": an id nobody can find, a code, no next step, and only the first variant --
 * fix that one, and the next one blocked.
 *
 * Through the campaign's real preview and the real run.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { AppError } from "../../app/lib/errors/app-error";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

describe("chaos: a campaign a blocking guardrail stops", () => {
  it("names every variant it stops, with its price and its floor, in the preview and in the run's refusal", async () => {
    await withChaos("guardrail-block-message", { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const names = ["Cascade Gloves · S", "Cascade Gloves · M", "Cascade Gloves · L"];
      for (const [i, gid] of variantGids.entries()) {
        await prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { title: names[i] } });
      }
      // A floor above every price, and the whole campaign blocked by it.
      await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });
      await prisma.campaign.update({ where: { id: campaignId }, data: { guardrailViolationPolicy: "block" } });

      const preview = await previewCampaign(shopId, campaignId, { limit: 100 });
      const said = preview.blocked?.message ?? "";
      expect(said).toMatch(/^A guardrail set to block the whole campaign would stop it before anything is written: /);
      for (const name of names) expect(said, `the preview left out ${name}`).toContain(`"${name}" would be $`);
      expect(said).toContain("under its $100,000.00 floor");
      expect(said).not.toMatch(/gid:\/\/|below-floor/);
      expect(said).toContain("take these 3 variants out of the campaign's products");

      const refused = await runCampaign(shopId, campaignId, chaosAdminClient(chaos.server.endpoint()), { actor: "chaos" }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused, "the run's refusal is not a guardrail error").toBeInstanceOf(AppError);
      expect((refused as AppError).code).toBe("GUARDRAIL_BLOCKED");
      const run = (refused as AppError).userMessage;
      expect(run).toMatch(/^A guardrail stopped this run before anything was written: /);
      for (const name of names) expect(run).toContain(`"${name}" would be $`);
      expect(run).not.toMatch(/gid:\/\/|below-floor/);
      expect(chaos.fake.writeLog, "a blocked campaign wrote").toHaveLength(0);
    });
  });
});
