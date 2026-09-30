/**
 * A guided first campaign is refused on the server until it is narrowed (#715).
 *
 * The page holds its create button until a scope is picked. That hold is in the browser;
 * this is the same rule for a submit that did not come through the button -- no
 * JavaScript, or a hand-built request -- so "start small" holds either way.
 *
 * Driven through the editor's own action; only `authenticate.admin` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

async function create(fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.campaigns.new");
  const body = new FormData();
  for (const [key, value] of Object.entries({ ruleKind: "percent-change", ruleValue: "-10", ...fields })) {
    body.set(key, value);
  }
  return action({
    request: new Request("https://example.invalid/app/campaigns/new", { method: "POST", body }),
    params: {},
    context: {},
  } as never);
}

/** What the error screen would say, from the report `withGuard` throws for it. */
async function refusal(fields: Record<string, string>): Promise<string> {
  const { ANCHOR_ERROR } = await import("../../app/lib/errors/guard.server");
  try {
    await create(fields);
  } catch (thrown) {
    const reported = (thrown as { data?: Record<string, { userMessage?: string; status?: number }> }).data?.[
      ANCHOR_ERROR
    ];
    expect(reported?.status).toBe(400);
    return reported?.userMessage ?? "";
  }
  throw new Error(`${fields.name} was created instead of refused`);
}

describe("chaos: a guided first campaign", () => {
  it("is refused while it covers the whole catalogue, and created once narrowed", async () => {
    await withChaos("guided-scope", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      pending = { shop: domain };
      const campaigns = () => prisma.campaign.count({ where: { shopId, name: { startsWith: "Guided" } } });

      expect(await refusal({ name: "Guided everything", guided: "1", vendor: "", title: "  " })).toMatch(
        /whole catalogue.*Pick a collection, a vendor, a tag or a title/,
      );
      expect(await refusal({ name: "Guided excluding", guided: "1", excludeTag: "clearance" })).toMatch(
        /whole catalogue/,
      );
      expect(await campaigns(), "a guided campaign over everything was created").toBe(0);

      const narrowed = await create({ name: "Guided narrowed", guided: "1", vendor: "Cascade" });
      expect(narrowed).toBeInstanceOf(Response);
      expect((narrowed as Response).headers.get("Location")).toMatch(/^\/app\/campaigns\//);

      // Only guided mode promises small: the ordinary editor still makes a
      // whole-catalogue campaign when asked to.
      await create({ name: "Guided-off everything", guided: "" });
      expect(await campaigns()).toBe(2);
    });
  });
});
