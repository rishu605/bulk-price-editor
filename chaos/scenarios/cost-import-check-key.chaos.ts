/**
 * A cost file's import writes the rows that were checked, and no others (#1059).
 *
 * The form disables Import once the rows are edited (#766), but the route wrote whatever
 * rows a commit posted: a stray submit, or a form somebody edited, wrote costs no check
 * had listed. Costs set the never-below-cost and minimum-margin floors, so a cost nobody
 * looked at moves a guardrail. The bulk cost editor on the same page has refused an
 * unchecked commit since #754, and the price import since #989; this is the file's turn,
 * through the Costs page's own action.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: {} }),
  },
}));

type Answer = { ok: boolean; message: string; checkKey?: string; imported?: { written: number; ready: number } };

async function post(fields: Record<string, string>): Promise<Answer> {
  const { action } = await import("../../app/routes/app.prices.costs");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return (await action({
    request: new Request("https://example.invalid/app/prices/costs", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as Answer;
}

describe("chaos: committing a cost file", () => {
  it("is refused without the check's key, or with rows that are not the ones checked", async () => {
    await withChaos("cost-import-check-key", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      pending = { shop: domain };
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[0] }, data: { sku: "CC-1" } });
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[1] }, data: { sku: "CC-2" } });
      const checked = "Variant SKU,Variant Cost\nCC-1,12.50";
      const edited = "Variant SKU,Variant Cost\nCC-1,12.50\nCC-2,1.00";

      // Both places a cost is written -- the mirror and the baseline -- and the audit.
      const written = async () => ({
        mirror: await prisma.variantIndex.findMany({
          where: { shopId },
          select: { variantGid: true, cost: true },
          orderBy: { variantGid: "asc" },
        }),
        baselines: await prisma.baseline.findMany({
          where: { shopId },
          select: { id: true, cost: true },
          orderBy: { id: "asc" },
        }),
        audit: await prisma.auditLogEntry.count({ where: { shopId } }),
      });
      const before = await written();

      // A commit nobody checked.
      const unchecked = await post({ intent: "import-commit", csv: checked });
      expect(unchecked.ok, "rows nobody checked were imported").toBe(false);
      expect(unchecked.message).toMatch(/not the ones that were checked, so no costs were written/);
      expect(unchecked.message).toMatch(/Check the file again/);
      expect(await written()).toEqual(before);

      // Checked one row, then a second added before Import.
      const answer = await post({ intent: "import-dry-run", csv: checked });
      expect(answer.ok).toBe(true);
      expect(answer.checkKey).toMatch(/^[0-9a-f]{64}$/);
      const checkedState = await written();
      expect(checkedState.mirror, "the check wrote a cost").toEqual(before.mirror);
      expect(checkedState.baselines, "the check wrote a cost").toEqual(before.baselines);
      const swapped = await post({ intent: "import-commit", csv: edited, checked: answer.checkKey! });
      expect(swapped.ok, "a row nobody checked was imported").toBe(false);
      expect(swapped.message).toMatch(/not the ones that were checked/);
      expect(swapped.imported, "the refusal read the file").toBeUndefined();
      expect(await written()).toEqual(checkedState);

      // The rows that were checked, with their key, go through -- line endings aside.
      const committed = await post({ intent: "import-commit", csv: `${checked.replace("\n", "\r\n")}\r\n`, checked: answer.checkKey! });
      expect(committed.ok, committed.message).toBe(true);
      expect(committed.imported?.written).toBe(1);
      // A commit spends its check: the page needs another before it can import again.
      expect(committed.checkKey).toBeUndefined();
      const cost = async (variantGid: string) =>
        (await prisma.variantIndex.findFirstOrThrow({ where: { shopId, variantGid }, select: { cost: true } })).cost;
      expect(await cost(variantGids[0])).toBe(1_250n);
      expect(await cost(variantGids[1]), "the row added after the check was imported").toBe(
        before.mirror.find((row) => row.variantGid === variantGids[1])!.cost,
      );
      expect(
        await prisma.baseline.count({ where: { shopId, variantGid: variantGids[0], supersededAt: null, cost: 1_250n } }),
      ).toBeGreaterThan(0);
      expect(
        await prisma.baseline.count({ where: { shopId, variantGid: variantGids[1], cost: 100n } }),
        "the row added after the check reached the baseline",
      ).toBe(0);
      expect((await written()).audit).toBe(checkedState.audit + 1);
    });
  });
});
