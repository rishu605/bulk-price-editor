/**
 * A bulk cost change writes only after a check of the same values, and the count it
 * confirmed (#754).
 *
 * The form opened as "Every product · Adjust by a percentage · 4", and the button beside
 * "Check without changing" committed whatever the form held. On a real store that was
 * 2,699 costs raised by 4% on one click, with a number the merchant never typed. Costs set
 * the never-below-cost and minimum-margin floors, so that click moved every guardrail in
 * the store.
 *
 * Driven through the route's own action, so what is tested is the request a merchant's
 * page sends; only `authenticate.admin` is replaced. Every refusal is checked against the
 * database as well as the message — a refusal that says "nothing was changed" while
 * writing is the failure this ticket is about.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

/** Who the next request authenticates as. Mutable, because the mock is bound once. */
let pendingShop = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pendingShop }, sessionToken: undefined }),
  },
}));

type Answer = {
  ok: boolean;
  message: string;
  field?: string;
  check?: { key: string; changed: number; matched: number; skipped: number; rule: string; scope: string };
};

async function submit(shopDomain: string, fields: Record<string, string>): Promise<Answer> {
  pendingShop = shopDomain;
  const { action } = await import("../../app/routes/app.prices.costs");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = await action({
    request: new Request("https://example.invalid/app/prices/costs", { method: "POST", body }),
    params: {},
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as Answer;
}

/** Every current BASE baseline's cost, in variant order. Null is "never had one". */
async function costsOf(shopId: string, variantGids: string[]): Promise<Array<bigint | null>> {
  const rows = await prisma.baseline.findMany({
    where: { shopId, variantGid: { in: variantGids }, supersededAt: null, surfaceKind: "BASE" },
    select: { variantGid: true, cost: true },
  });
  const by = new Map(rows.map((row) => [row.variantGid, row.cost]));
  return variantGids.map((gid) => by.get(gid) ?? null);
}

const SET_12 = { ruleKind: "set-exact", value: "12" };

describe("chaos: the bulk cost change asks first", () => {
  it("refuses an empty amount on both buttons, rather than setting every cost to zero", async () => {
    await withChaos(
      "cost-bulk-empty",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids } = chaos.fixture;

        for (const intent of ["dry-run", "commit"]) {
          const answer = await submit(domain, { ruleKind: "set-exact", value: "", intent });

          expect(answer.ok, `${intent} ran on an empty amount`).toBe(false);
          expect(answer.field).toBe("value");
          expect(answer.message).toMatch(/amount is empty/);
          expect(answer.check).toBeUndefined();
        }

        // `Number("")` is 0: before the fix, the commit set every cost here to nothing.
        expect(await costsOf(shopId, variantGids)).toEqual([null, null, null]);
      },
    );
  });

  it("refuses a commit that no check came before", async () => {
    await withChaos(
      "cost-bulk-unchecked",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids } = chaos.fixture;

        // What the "Change these costs" button sent: the form, and the word commit.
        const answer = await submit(domain, { ...SET_12, intent: "commit" });

        expect(answer.ok).toBe(false);
        expect(answer.message).toMatch(/have not been checked/);
        expect(await costsOf(shopId, variantGids)).toEqual([null, null, null]);
      },
    );
  });

  it("refuses a commit whose values moved after the check", async () => {
    await withChaos(
      "cost-bulk-moved",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids } = chaos.fixture;

        const dry = await submit(domain, { ...SET_12, intent: "dry-run" });
        expect(dry.ok).toBe(true);
        expect(dry.check).toMatchObject({ changed: 3, matched: 3, scope: "Every product" });

        // The amount edited after checking 12, and the check's key posted with it.
        const answer = await submit(domain, {
          ruleKind: "set-exact",
          value: "120",
          intent: "commit",
          checked: dry.check!.key,
          expected: String(dry.check!.changed),
        });

        expect(answer.ok).toBe(false);
        expect(answer.message).toMatch(/no longer matches what was checked/);
        expect(await costsOf(shopId, variantGids)).toEqual([null, null, null]);
      },
    );
  });

  it("refuses a commit whose count moved after the check, and names both counts", async () => {
    await withChaos(
      "cost-bulk-recounted",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids } = chaos.fixture;

        const dry = await submit(domain, { ...SET_12, intent: "dry-run" });
        expect(dry.check?.changed).toBe(3);

        // Between the check and the click, one variant already reaches $12 — an import
        // in another tab, say. The merchant confirmed three; two would be written.
        await prisma.baseline.updateMany({
          where: { shopId, variantGid: variantGids[0], supersededAt: null, surfaceKind: "BASE" },
          data: { cost: 1_200n },
        });

        const answer = await submit(domain, {
          ...SET_12,
          intent: "commit",
          checked: dry.check!.key,
          expected: String(dry.check!.changed),
        });

        expect(answer.ok).toBe(false);
        expect(answer.message).toContain("2 costs would change now, not the 3 you were shown");
        // Refused before the first write, not part-way through.
        expect(await costsOf(shopId, variantGids)).toEqual([1_200n, null, null]);
      },
    );
  });

  it("writes after a check of the same values, and the check is spent", async () => {
    await withChaos(
      "cost-bulk-confirmed",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, variantGids } = chaos.fixture;

        const dry = await submit(domain, { ...SET_12, intent: "dry-run" });
        expect(dry.message).toBe(
          "Set every matching cost to 12.00: 3 of 3 would change. Nothing has been written.",
        );
        expect(await costsOf(shopId, variantGids)).toEqual([null, null, null]);

        // "12.0" is the 12 that was checked: the key is of the rule, not the keystrokes.
        const answer = await submit(domain, {
          ruleKind: "set-exact",
          value: "12.0",
          intent: "commit",
          checked: dry.check!.key,
          expected: String(dry.check!.changed),
        });

        expect(answer).toMatchObject({ ok: true, message: "3 costs updated." });
        // A commit's answer carries no check, so the page's button goes back to needing one.
        expect(answer.check).toBeUndefined();
        expect(await costsOf(shopId, variantGids)).toEqual([1_200n, 1_200n, 1_200n]);
      },
    );
  });
});
