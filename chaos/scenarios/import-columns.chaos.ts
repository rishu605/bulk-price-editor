/**
 * A spreadsheet campaign reads every column it accepts, and its counts add up (#766).
 *
 * - The compare-at column was checked against the price -- refusing rows over it -- stored,
 *   and then never written, because the campaign the import made said "leave". The file's
 *   compare-at is the strike-through now, and comes off again on revert.
 * - A row in another currency was parsed in that currency and read back in the shop's:
 *   `1200,JPY` became $12.00. Refused, naming both currencies.
 * - "Need attention" was the length of lists that stop at 500, so a large bad file read
 *   Rows read ≠ Ready + Need attention. The importer counts every problem now.
 *
 * Driven through the import route's own action, check then commit as the editor posts
 * them; only `authenticate.admin` is replaced. The campaign it makes is run against the
 * modelled store through the real run path.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { PriceImportResult } from "../../app/services/price-import.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { CHAOS_ACTOR, withChaos } from "../harness/scenario";
import { judge } from "../harness/verdict";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

/** One post to the import route, as the editor's import form makes it. */
async function post(fields: Record<string, string>): Promise<unknown> {
  const { action } = await import("../../app/routes/app.price-import");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return action({
    request: new Request("https://example.invalid/app/price-import", { method: "POST", body }),
    params: {},
    context: {},
  } as never);
}

async function check(csv: string): Promise<PriceImportResult> {
  const answer = (await post({ intent: "dry-run", csv })) as { result: PriceImportResult };
  expect(answer.result.dryRun).toBe(true);
  return answer.result;
}

async function commit(csv: string): Promise<string> {
  const response = (await post({ intent: "commit", csv, name: "Sale · 14/10/2026" })) as Response;
  const location = response.headers.get("Location") ?? "";
  expect(location, "the import did not create a campaign").toMatch(/^\/app\/campaigns\//);
  return location.split("/").pop()!;
}

describe("chaos: the columns of a price file", () => {
  it("writes the file's compare-at, refuses another currency, and counts every row", async () => {
    await withChaos("import-columns", { catalog: { products: 4, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids, baseline } = chaos.fixture;
      const [v0, v1, v2, v3] = variantGids;
      pending = { shop: domain };
      await Promise.all(
        variantGids.map((gid, i) =>
          prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { sku: `SKU-${i}` } }),
        ),
      );

      // SKU-3 already has a strike-through of its own, which a row with no compare-at must
      // leave where it is.
      await prisma.baseline.updateMany({ where: { shopId, variantGid: v3 }, data: { baseCompareAt: 9_900n } });
      await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid: v3 }, data: { liveCompareAt: 9_900n } });
      chaos.fake.variants.get(v3)!.compareAtPrice = "99.00";

      // The file from the live reproduction, by SKU rather than by gid.
      const csv = [
        "Variant SKU,Variant Price,Variant Compare At Price,Currency",
        "SKU-0,13.00,,",
        "SKU-1,20.00,30.00,",
        "SKU-2,1200,,JPY",
        "SKU-3,9.00,,",
        "SKU-3,8.50,,",
        "SKU-404,10.00,,",
        "SKU-0,abc,,",
      ].join("\n");

      const checked = await check(csv);
      expect({ total: checked.total, ready: checked.ready, problems: checked.problems }).toEqual({
        total: 7,
        ready: 3,
        problems: 4,
      });
      // In a USD shop the yen row was Ready, and became $12.00.
      const yen = checked.invalid.find((problem) => problem.line === 4);
      expect(yen?.reason, "a row in another currency was read in the shop's").toMatch(/in JPY, but .* in USD/);

      // Rows read = Ready + Need attention, however many need attention. Each list the
      // report is sent stops at 500; the count does not.
      const large = await check(
        ["Variant SKU,Variant Price", "SKU-0,13.00", ...Array.from({ length: 600 }, (_, i) => `NOPE-${i},1.00`)].join("\n"),
      );
      expect(large.unmatched).toHaveLength(500);
      expect(large.problems).toBe(600);
      expect(large.ready + large.problems).toBe(large.total);

      // The commit, and the campaign it makes.
      const campaignId = await commit(csv);
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const rule = (campaign.ruleRows as Array<{ rule: { kind: string; importId: string } }>)[0].rule;
      expect(campaign.compareAtPolicy).toEqual({ kind: "from-import", importId: rule.importId });

      // The preview shows the strike-through, from the same plan the run makes.
      const preview = await previewCampaign(shopId, campaignId);
      const previewed = new Map(preview.rows.map((row) => [row.variantGid, row]));
      expect(previewed.get(v1)?.compareAt, "the preview dropped the file's compare-at").toMatch(/30\.00/);

      const client = chaosAdminClient(chaos.server.endpoint());
      const applied = await runCampaign(shopId, campaignId, client, { actor: CHAOS_ACTOR, verifySampleRate: 1 });
      const verdict = await judge({ ...chaos.fixture, campaignId }, chaos.fake, applied.runId);
      expect(verdict.violations).toEqual([]);

      const live = (gid: string) => chaos.fake.variants.get(gid)!;
      expect(live(v1), "the file's compare-at was not written").toMatchObject({ price: "20.00", compareAtPrice: "30.00" });
      expect(live(v0)).toMatchObject({ price: "13.00", compareAtPrice: null });
      expect(live(v3), "an empty cell wiped the variant's own compare-at").toMatchObject({ price: "9.00", compareAtPrice: "99.00" });
      // The yen row priced nothing.
      expect(Number(live(v2).price.replace(".", ""))).toBe(baseline.get(v2));

      // Revert recomputes without the campaign: the file's strike-through comes off, and the
      // variant's own stays.
      const reverted = await runCampaign(shopId, campaignId, client, {
        actor: CHAOS_ACTOR,
        revert: true,
        verifySampleRate: 1,
      });
      expect((await judge({ ...chaos.fixture, campaignId }, chaos.fake, reverted.runId)).violations).toEqual([]);
      expect(live(v1).compareAtPrice, "revert left the file's compare-at on the storefront").toBeNull();
      expect(live(v3).compareAtPrice).toBe("99.00");
      for (const gid of [v0, v1, v3]) {
        expect(Number(live(gid).price.replace(".", ""))).toBe(baseline.get(gid));
      }
    });
  });
});
