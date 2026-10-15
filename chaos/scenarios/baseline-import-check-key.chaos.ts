/**
 * A baseline file's import writes the rows that were checked, and no others (#1059).
 *
 * The form disables Import once the rows are edited (#766), but the route wrote whatever
 * rows a commit posted: a stray submit, or a form somebody edited, wrote baselines no
 * check had listed. A baseline is what every campaign computes from, so a row nobody
 * looked at mis-prices that variant on every campaign after it. The price import has
 * refused this since #989; this is the same rule, through the Baselines page's own action.
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

type Answer = { ok: boolean; message: string; checkKey?: string; result?: { written: number; ready: number } };

async function post(fields: Record<string, string>): Promise<Answer> {
  const { action } = await import("../../app/routes/app.prices.baselines._index");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return (await action({
    request: new Request("https://example.invalid/app/prices/baselines", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as Answer;
}

describe("chaos: committing a baseline file", () => {
  it("is refused without the check's key, or with rows that are not the ones checked", async () => {
    await withChaos("baseline-import-check-key", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      pending = { shop: domain };
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[0] }, data: { sku: "BK-1" } });
      await prisma.variantIndex.updateMany({ where: { shopId, variantGid: variantGids[1] }, data: { sku: "BK-2" } });
      const checked = "Variant SKU,Price\nBK-1,123.45";
      const edited = "Variant SKU,Price\nBK-1,123.45\nBK-2,1.00";

      // Every baseline row the shop has, current or superseded, and every audit entry: a
      // refused commit moves none of them. (A check is audited, so it moves the count.)
      const written = async () => ({
        baselines: await prisma.baseline.findMany({
          where: { shopId },
          select: { id: true, variantGid: true, surfaceKind: true, basePrice: true, supersededAt: true },
          orderBy: { id: "asc" },
        }),
        audit: await prisma.auditLogEntry.count({ where: { shopId } }),
      });
      const before = await written();

      // A commit nobody checked.
      const unchecked = await post({ intent: "commit", csv: checked });
      expect(unchecked.ok, "rows nobody checked were imported").toBe(false);
      expect(unchecked.message).toMatch(/not the ones that were checked, so no baselines were written/);
      expect(unchecked.message).toMatch(/Check the file again/);
      expect(await written()).toEqual(before);

      // Checked one row, then a second added before Import.
      const answer = await post({ intent: "dry-run", csv: checked });
      expect(answer.ok).toBe(true);
      expect(answer.checkKey).toMatch(/^[0-9a-f]{64}$/);
      const checkedState = await written();
      expect(checkedState.baselines, "the check wrote a baseline").toEqual(before.baselines);
      const swapped = await post({ intent: "commit", csv: edited, checked: answer.checkKey! });
      expect(swapped.ok, "a row nobody checked was imported").toBe(false);
      expect(swapped.message).toMatch(/not the ones that were checked/);
      expect(swapped.result, "the refusal read the file").toBeUndefined();
      expect(await written()).toEqual(checkedState);

      // The rows that were checked, with their key, go through -- line endings aside.
      const committed = await post({ intent: "commit", csv: `${checked.replace("\n", "\r\n")}\r\n`, checked: answer.checkKey! });
      expect(committed.ok, committed.message).toBe(true);
      expect(committed.result?.written).toBe(1);
      // A commit spends its check: the page needs another before it can import again.
      expect(committed.checkKey).toBeUndefined();
      const current = await prisma.baseline.findFirstOrThrow({
        where: { shopId, variantGid: variantGids[0], surfaceKind: "BASE", supersededAt: null },
      });
      expect(current.basePrice).toBe(12_345n);
      const untouched = await prisma.baseline.findFirstOrThrow({
        where: { shopId, variantGid: variantGids[1], surfaceKind: "BASE", supersededAt: null },
      });
      const was = before.baselines.find((row) => row.variantGid === variantGids[1] && row.surfaceKind === "BASE" && !row.supersededAt);
      expect(untouched.basePrice, "the row added after the check was imported").toBe(was!.basePrice);
      expect((await written()).audit).toBe(checkedState.audit + 1);
    });
  });
});
