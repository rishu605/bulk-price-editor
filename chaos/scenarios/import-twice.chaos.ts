/**
 * A second spreadsheet import under the same name is a second campaign, and an import that
 * cannot become a campaign leaves nothing behind (#719).
 *
 * The import's segment was always named "<name> (imported)", and segment names are unique per
 * shop: the second import under the editor's default name failed on the segment, after the
 * import itself had been committed. The merchant got the error screen, and every retry left
 * another import with no campaign in the history.
 *
 * Driven through the import route's own action; only `authenticate.admin` is replaced, and
 * `createCampaign` can be made to fail once.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };
let failNextCampaign = false;

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

vi.mock("../../app/services/campaigns/index.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../app/services/campaigns/index.server")>();
  return {
    ...original,
    createCampaign: async (...args: Parameters<typeof original.createCampaign>) => {
      if (failNextCampaign) {
        failNextCampaign = false;
        throw new Error("chaos: the campaign could not be created");
      }
      return original.createCampaign(...args);
    },
  };
});

/** The key the import route's check answers with for these rows. */
async function checkKeyFor(csv: string): Promise<string> {
  const { action } = await import("../../app/routes/app.price-import");
  const body = new FormData();
  body.set("intent", "dry-run");
  body.set("csv", csv);
  const answer = (await action({
    request: new Request("https://example.invalid/app/price-import", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as { checkKey: string };
  return answer.checkKey;
}

/** The import form's commit, as the editor posts it. */
async function commit(fields: Record<string, string>): Promise<Response> {
  const { action } = await import("../../app/routes/app.price-import");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  // As the editor does: a commit carries the key its check answered with (#989).
  if (fields.intent === "commit") body.set("checked", await checkKeyFor(fields.csv));
  return (await action({
    request: new Request("https://example.invalid/app/price-import", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as Response;
}

const campaignOf = (response: Response) => {
  const location = response.headers.get("Location") ?? "";
  expect(location, "the import did not create a campaign").toMatch(/^\/app\/campaigns\//);
  return location.split("/").pop()!;
};

describe("chaos: importing a spreadsheet twice", () => {
  it("makes a second campaign under the same name, and leaves nothing when one cannot be made", async () => {
    await withChaos("import-twice", { catalog: { products: 2, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, variantGids } = chaos.fixture;
      pending = { shop: domain };
      await Promise.all(
        variantGids.map((gid, i) =>
          prisma.variantIndex.updateMany({ where: { shopId, variantGid: gid }, data: { sku: `SKU-${i}` } }),
        ),
      );
      const csv = ["Variant SKU,Variant Price", ...variantGids.map((_, i) => `SKU-${i},1.00`)].join("\n");

      // No name: the editor's default, which is what a merchant importing twice a day sends.
      const first = campaignOf(await commit({ intent: "commit", csv }));
      const second = campaignOf(await commit({ intent: "commit", csv }));
      expect(second).not.toBe(first);

      const segments = await prisma.campaign.findMany({
        where: { id: { in: [first, second] } },
        select: { id: true, segments: { select: { name: true, frozenVariantGids: true } } },
      });
      const nameOf = new Map(segments.map((c) => [c.id, c.segments.map((s) => s.name)]));
      expect(nameOf.get(first)).toEqual(["Imported prices (imported)"]);
      expect(nameOf.get(second)).toEqual(["Imported prices (imported 2)"]);
      for (const c of segments) expect([...c.segments[0].frozenVariantGids].sort()).toEqual([...variantGids].sort());

      // The import committed, and its campaign could not be made: nothing is left of it.
      const before = {
        imports: await prisma.priceImport.count({ where: { shopId } }),
        segments: await prisma.segment.count({ where: { shopId } }),
        campaigns: await prisma.campaign.count({ where: { shopId } }),
      };
      failNextCampaign = true;
      const thrown = await commit({ intent: "commit", csv }).catch((error: unknown) => error);
      expect(failNextCampaign, "the failure was never reached").toBe(false);
      expect(thrown instanceof Response && thrown.headers.get("Location")?.startsWith("/app/campaigns/")).not.toBe(true);
      expect({
        imports: await prisma.priceImport.count({ where: { shopId } }),
        segments: await prisma.segment.count({ where: { shopId } }),
        campaigns: await prisma.campaign.count({ where: { shopId } }),
      }, "a failed import left an import or a segment behind").toEqual(before);

      // And the next attempt still works, under the name the failed one would have had.
      const third = campaignOf(await commit({ intent: "commit", csv }));
      const made = await prisma.campaign.findUniqueOrThrow({ where: { id: third }, select: { segments: { select: { name: true } } } });
      expect(made.segments.map((s) => s.name)).toEqual(["Imported prices (imported 3)"]);
    });
  });
});
