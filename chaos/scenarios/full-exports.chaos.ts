/**
 * Every export holds every row it names, not the rows on screen (#819).
 *
 * "Export this ledger" on a 3,666-row run downloaded about 60 rows, the preview export a
 * screenful, and Prices and Activity one page. Each is now the export route reading the
 * whole scope on the server. Driven through that route's own loader, with only
 * `authenticate.admin` replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { EXPORT_PAGE } from "../../app/routes/app.export.$kind";
import { withChaos } from "../harness/scenario";

let domain = "";
vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: domain },
      admin: { graphql: async () => new Response(JSON.stringify({ data: {} })) },
    }),
  },
}));

async function exported(path: string): Promise<{ status: number; body: string; lines: string[] }> {
  const { loader } = await import("../../app/routes/app.export.$kind");
  const [kind, query = ""] = path.split("?");
  const response = (await loader({
    request: new Request(`https://example.invalid/app/export/${kind}${query ? `?${query}` : ""}`),
    params: { kind },
    context: {},
  } as never)) as Response;
  const body = await response.text();
  return { status: response.status, body, lines: body.split("\n").filter((line) => line.length > 0) };
}

const VARIANTS = EXPORT_PAGE + 150;

/** One field of a CSV line whose fields hold no commas, unquoted. */
const field = (line: string, index: number) => (line.split(",")[index] ?? "").replace(/^"|"$/g, "");

describe("chaos: exporting more than a screen", () => {
  it("exports every row of a 5,000-row ledger, every variant of a plan, and every page of Prices and Activity", async () => {
    await withChaos("full-exports", { catalog: { products: VARIANTS, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      domain = chaos.fixture.domain;

      // A run with 5,000 ledger rows -- the acceptance test -- without writing 5,000 prices.
      const run = await prisma.campaignRun.create({
        data: { shopId, campaignId, kind: "APPLY", status: "COMPLETED", occurrenceKey: "EXPORT-TEST", plannedRows: 5_000 },
      });
      await prisma.variantChange.createMany({
        data: Array.from({ length: 5_000 }, (_, i) => ({
          runId: run.id,
          shopId,
          variantGid: `gid://shopify/ProductVariant/export-${i}`,
          surfaceKind: "BASE" as const,
          priceListGid: "",
          currency: "USD",
          beforePrice: 1_000n,
          intendedPrice: 900n,
          status: "VERIFIED" as const,
        })),
      });
      const ledger = await exported(`ledger?run=${run.id}`);
      expect(ledger.status).toBe(200);
      expect(ledger.lines, "the ledger export held a screenful").toHaveLength(1 + 5_000);
      expect(new Set(ledger.lines.slice(1).map((line) => field(line, 0))).size).toBe(5_000);

      // The plan: every variant in scope, though the page shows a screenful.
      const preview = await exported(`preview?campaign=${campaignId}`);
      expect(preview.status).toBe(200);
      expect(preview.lines.length - 1, "the preview export held a screenful").toBe(VARIANTS);

      // Prices → What's live and Baselines: more than one read's worth, each exactly once.
      for (const kind of ["live", "baselines"]) {
        const page = await exported(kind);
        expect(page.status).toBe(200);
        expect(page.lines.length - 1, `${kind} held one page`).toBe(VARIANTS);
        // The variant's id: first on What's live, second (after the SKU) on Baselines.
        const column = kind === "baselines" ? 1 : 0;
        const ids = page.lines.slice(1).map((line) => field(line, column));
        expect(new Set(ids).size, `${kind} repeated or skipped a row across reads`).toBe(VARIANTS);
        expect(ids).toEqual(expect.arrayContaining([variantGids[0], variantGids[VARIANTS - 1]]));
      }

      // A page's filters narrow its export the way they narrow the page.
      const one = await exported(`baselines?q=${encodeURIComponent(variantGids[7])}`);
      expect(one.lines.length - 1).toBeLessThanOrEqual(1);

      // Activity, with entries sharing one timestamp across a read boundary.
      const at = new Date();
      await prisma.auditLogEntry.createMany({
        data: Array.from({ length: EXPORT_PAGE + 40 }, (_, i) => ({
          shopId,
          action: "export.test",
          entity: "Shop",
          entityId: `entry-${i}`,
          createdAt: at,
        })),
      });
      const log = await exported("activity?action=export.test");
      expect(log.lines.length - 1, "activity repeated or skipped tied entries").toBe(EXPORT_PAGE + 40);
      expect(new Set(log.lines.slice(1).map((line) => field(line, 4))).size).toBe(EXPORT_PAGE + 40);

      // Another store's run is not exported.
      const other = await prisma.shop.create({ data: { domain: `chaos-full-exports-other.myshopify.com` } });
      const foreign = await prisma.campaignRun.create({
        data: {
          shopId: other.id,
          campaignId: (await prisma.campaign.create({ data: { shopId: other.id, name: "Other" } as never })).id,
          kind: "APPLY",
          status: "COMPLETED",
          occurrenceKey: "EXPORT-OTHER",
        },
      });
      expect((await exported(`ledger?run=${foreign.id}`)).status).toBe(404);
      await prisma.shop.delete({ where: { id: other.id } });
    });
  }, 300_000);
});
