/**
 * A price file's commit is the rows that were checked, and the baseline import counts every
 * problem, past its list's cap (#989).
 *
 * The form disables Create after an edit (#766), but the route took whatever rows a commit
 * posted: a stray submit, or a form somebody edited, made a campaign from rows nobody had
 * checked. And the baseline import's "Need attention" was the length of lists that stop at
 * 5,000 each.
 *
 * Through the import route's own action, and the baseline importer.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { importBaselines } from "../../app/services/baseline-import.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: {} }),
  },
}));

async function post(fields: Record<string, string>): Promise<{ ok?: boolean; message?: string; checkKey?: string } | Response> {
  const { action } = await import("../../app/routes/app.price-import");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return action({
    request: new Request("https://example.invalid/app/price-import", { method: "POST", body }),
    params: {},
    context: {},
  } as never) as never;
}

async function* lines(text: string) {
  for (const line of text.split("\n")) yield line;
}

describe("chaos: committing a price file", () => {
  it("is refused without the check's key, or with rows that are not the ones checked", async () => {
    await withChaos("import-check-key", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      pending = { shop: domain };
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[0] }, data: { sku: "CK-1" } });
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[1] }, data: { sku: "CK-2" } });
      const checked = "Variant SKU,Variant Price\nCK-1,10.00";
      const edited = "Variant SKU,Variant Price\nCK-1,10.00\nCK-2,1.00";
      const imports = () => prisma.priceImport.count({ where: { shopId } });
      const campaigns = () => prisma.campaign.count({ where: { shopId } });
      const [importsBefore, campaignsBefore] = [await imports(), await campaigns()];

      // A commit nobody checked.
      const unchecked = (await post({ intent: "commit", csv: checked, name: "Unchecked" })) as { ok: boolean; message: string };
      expect(unchecked.ok).toBe(false);
      expect(unchecked.message).toMatch(/not the ones that were checked/);

      // Checked one row, then a second added before Create.
      const answer = (await post({ intent: "dry-run", csv: checked })) as { checkKey: string };
      expect(answer.checkKey).toMatch(/^[0-9a-f]{64}$/);
      const swapped = (await post({ intent: "commit", csv: edited, name: "Swapped", checked: answer.checkKey })) as { ok: boolean };
      expect(swapped.ok, "rows nobody checked made a campaign").toBe(false);
      expect(await imports()).toBe(importsBefore);
      expect(await campaigns()).toBe(campaignsBefore);

      // The rows that were checked, with their key, go through -- line endings aside.
      const committed = (await post({ intent: "commit", csv: `${checked.replace("\n", "\r\n")}\n`, name: "Checked", checked: answer.checkKey })) as Response;
      expect(committed.headers.get("Location")).toMatch(/^\/app\/campaigns\//);
      expect(await campaigns()).toBe(campaignsBefore + 1);
    });
  });

  it("counts every baseline problem, past the 5,000 the report lists", async () => {
    await withChaos("baseline-import-count", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const rows = Array.from({ length: 5_010 }, (_, i) => `NO-SUCH-${i},10.00`);
      const result = await importBaselines(shopId, lines(["Variant SKU,Price", ...rows].join("\n")), "USD", { dryRun: true });
      expect(result.unmatched.length, "the list is a sample").toBe(5_000);
      expect(result.problems, "the count stopped at the list").toBe(5_010);
      expect(result.total).toBe(result.ready + result.unchanged + result.problems);
    });
  });
});
