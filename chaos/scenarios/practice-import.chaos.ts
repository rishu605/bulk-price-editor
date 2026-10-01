/**
 * A spreadsheet campaign started in practice mode is a practice campaign (#765).
 *
 * Practice mode promises "nothing will be written to your storefront — not now, and not
 * later. This campaign cannot be applied at all." The editor carries that as a hidden
 * field in its own form, and the spreadsheet posts from a form of its own to
 * `/app/price-import` -- which created an ordinary campaign, appliable, writing the
 * file's prices to the live storefront.
 *
 * Driven through the import route's own action; only `authenticate.admin` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { isPractice } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

/** The import form's commit, as the editor posts it. */
async function commit(fields: Record<string, string>): Promise<string> {
  const { action } = await import("../../app/routes/app.price-import");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = (await action({
    request: new Request("https://example.invalid/app/price-import", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as Response;
  const location = response.headers.get("Location") ?? "";
  expect(location, "the import did not create a campaign").toMatch(/^\/app\/campaigns\//);
  return location.split("/").pop()!;
}

describe("chaos: a spreadsheet campaign made in practice mode", () => {
  it("is a practice campaign: previewed, never applied", async () => {
    await withChaos("practice-import", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids, baseline } = chaos.fixture;
      pending = { shop: domain };
      await Promise.all(
        variantGids.map((gid, i) =>
          prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { sku: `SKU-${i}` } }),
        ),
      );
      const csv = ["Variant SKU,Variant Price", ...variantGids.map((_, i) => `SKU-${i},1.00`)].join("\n");

      const practiceId = await commit({ intent: "commit", csv, name: "Practice · import", practice: "1" });
      const practice = await prisma.campaign.findUniqueOrThrow({ where: { id: practiceId } });
      expect(isPractice(practice), "a practice import came out a real campaign").toBe(true);

      await expect(
        runCampaign(shopId, practiceId, chaosAdminClient(chaos.server.endpoint()), {}),
        "a practice import was applied to the storefront",
      ).rejects.toThrow(/practice campaign/);
      for (const gid of variantGids) {
        expect(Number(chaos.fake.priceOf(gid)!.replace(".", ""))).toBe(baseline.get(gid));
      }

      // The control: the same file, outside practice mode, is an ordinary campaign.
      const realId = await commit({ intent: "commit", csv, name: "Real import", practice: "" });
      expect(isPractice(await prisma.campaign.findUniqueOrThrow({ where: { id: realId } }))).toBe(false);
    });
  });
});
