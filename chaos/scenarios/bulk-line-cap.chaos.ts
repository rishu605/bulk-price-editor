/**
 * A bulk run over products with more variants in scope than one line takes (#985).
 *
 * A bulk upload is one `productVariantsBulkUpdate` per line, and the builder wrote one line
 * per product, carrying every variant. That mutation refuses an input array over 250 and a
 * product can have 2,048 variants, so a bulk campaign pricing 600 of one product's variants
 * would have had the line refused and every one of them failed. Resume built the same line
 * and failed the same way. #847 fixed this on the sync path; this is the bulk half. The
 * fake now refuses a line over 250 as it refuses a direct write that size, so the suite
 * can see it.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { selectWritePath } from "../../app/lib/planning/write-path";
import { ledgerOf, withChaos } from "../harness/scenario";

describe("chaos: a bulk run over products with more than 250 variants in scope", () => {
  it("prices 1,200 variants of two products on the bulk path, never over 250 a line, and ends verified-clean", async () => {
    await withChaos(
      "bulk-line-cap",
      { catalog: { products: 2, variantsPerProduct: 600 }, percent: -10 },
      async (chaos) => {
        const { variantGids, baseline, campaignId } = chaos.fixture;
        // Over the bulk threshold on its own: the path a merchant's campaign takes, not
        // one a test forced.
        expect(selectWritePath(variantGids.length).path).toBe("bulk");
        const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.9) / 100).toFixed(2);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Every price went through the bulk operation, in lines Shopify takes: three per
        // product, each variant on exactly one of them.
        expect(chaos.fake.variantWriteSizes, "a price went down the sync path").toEqual([]);
        const sizes = chaos.fake.bulkLines.map((line) => line.variantGids.length);
        expect(Math.max(...sizes), "a bulk line went over Shopify's 250-variant cap").toBeLessThanOrEqual(250);
        expect([...sizes].sort((a, b) => b - a)).toEqual([250, 250, 250, 250, 100, 100]);
        const sent = chaos.fake.bulkLines.flatMap((line) => line.variantGids);
        expect(sent).toHaveLength(variantGids.length);
        expect(new Set(sent)).toEqual(new Set(variantGids));

        expect(applied.verified).toBe(variantGids.length);
        expect(applied.failed).toBe(0);
        expect(applied.unverified).toBe(0);
        expect(applied.clean).toBe(true);
        const outstanding = await prisma.variantChange.count({
          where: { runId: applied.runId, status: { not: "VERIFIED" } },
        });
        expect(outstanding).toBe(0);
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");
      },
    );
  });

  it("fails only a refused line's rows, and Resume sends them again in lines Shopify takes", async () => {
    await withChaos(
      "bulk-line-cap-refused",
      { catalog: { products: 2, variantsPerProduct: 600 }, percent: -10 },
      async (chaos) => {
        const { variantGids, baseline, campaignId } = chaos.fixture;
        const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);
        const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.9) / 100).toFixed(2);

        // The first two lines -- the first product's first 500 variants -- are refused
        // whole; the operation runs the rest.
        chaos.fake.bulkRefusesLines = [0, 1];
        const first = await chaos.apply();
        await chaos.expectHonest(first.runId);

        const [line0, line1] = chaos.fake.bulkLines;
        expect(line0.productId, "both refused lines are one product's").toBe(line1.productId);
        const refused = new Set([...line0.variantGids, ...line1.variantGids]);
        expect(refused.size).toBe(500);

        // Those 500 rows failed with Shopify's reason, and only those: the product's third
        // line and the other product's three landed and were read back.
        expect(first.clean).toBe(false);
        expect(first.failed).toBe(500);
        expect(first.verified).toBe(700);
        expect(first.unverified).toBe(0);
        const ledger = await ledgerOf(first.runId);
        const failed = ledger.filter((row) => row.status === "FAILED");
        expect(new Set(failed.map((row) => row.variantGid))).toEqual(refused);
        for (const row of failed) {
          expect(row.failureReason).toMatch(/Internal error/);
          expect(chaos.fake.priceOf(row.variantGid)).toBe(full(row.variantGid));
        }
        for (const row of ledger.filter((r) => !refused.has(r.variantGid))) {
          expect(row.status).toBe("VERIFIED");
          expect(chaos.fake.priceOf(row.variantGid)).toBe(sale(row.variantGid));
        }
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");

        // ------------------------------------------------------------ resume
        // 500 rows is under the bulk threshold; forced, so the resume's own lines are the
        // ones under test -- one product's 500, which used to go as one line of 500.
        const linesBefore = chaos.fake.bulkLines.length;
        const resumed = await chaos.apply({ resume: true, forcePath: "bulk" });
        await chaos.expectHonest(resumed.runId);

        expect(resumed.planned, "Resume planned more, or less, than was outstanding").toBe(500);
        const resent = chaos.fake.bulkLines.slice(linesBefore);
        expect(resent.map((line) => line.variantGids.length)).toEqual([250, 250]);
        expect(new Set(resent.flatMap((line) => line.variantGids))).toEqual(refused);
        expect(resumed.clean).toBe(true);
        for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");
      },
    );
  });

  it("puts each userError on the variant its own line names, not on the product's nth or a neighbour", async () => {
    await withChaos(
      "bulk-line-cap-user-errors",
      { catalog: { products: 1, variantsPerProduct: 600 }, percent: -10 },
      async (chaos) => {
        const { variantGids, baseline } = chaos.fixture;
        const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.9) / 100).toFixed(2);

        // Deleted in Shopify, still in the mirror (E4): each write is refused with a userError
        // at the variant's index in its line, and the line reports every variant but it.
        // Spread across the product so they sit on different lines, two of them adjacent.
        const deleted = [3, 253, 254, 597].map((i) => variantGids[i]);
        for (const gid of deleted) chaos.fake.deleteVariant(gid);

        const applied = await chaos.apply({ forcePath: "bulk" });
        await chaos.expectHonest(applied.runId);
        expect(chaos.fake.bulkLines.map((line) => line.variantGids.length)).toEqual([250, 250, 100]);

        const ledger = await ledgerOf(applied.runId);
        const failed = ledger.filter((row) => row.status === "FAILED");
        expect(new Set(failed.map((row) => row.variantGid)), "a userError landed on another variant").toEqual(
          new Set(deleted),
        );
        for (const row of failed) expect(row.failureReason).toMatch(/does not exist/);
        // Every other variant -- the deleted ones' neighbours included -- landed and was read back.
        const others = ledger.filter((row) => !deleted.includes(row.variantGid));
        expect(others).toHaveLength(596);
        for (const row of others) {
          expect(row.status).toBe("VERIFIED");
          expect(chaos.fake.priceOf(row.variantGid)).toBe(sale(row.variantGid));
        }
        expect(applied.clean).toBe(false);
      },
    );
  });

  it("the fake refuses a bulk line over 250 whole, under its line number, and runs the rest", async () => {
    await withChaos(
      "bulk-line-cap-fake",
      { catalog: { products: 2, variantsPerProduct: 251 }, percent: -10 },
      async (chaos) => {
        const { variantGids, productOf, baseline } = chaos.fixture;
        const [big, other] = [...new Set(variantGids.map((gid) => productOf.get(gid)!))];
        const of = (product: string) => variantGids.filter((gid) => productOf.get(gid) === product);
        const body =
          [
            { productId: big, variants: of(big).map((id) => ({ id, price: "1.00" })) },
            { productId: other, variants: of(other).slice(0, 1).map((id) => ({ id, price: "2.00" })) },
          ]
            .map((line) => JSON.stringify(line))
            .join("\n") + "\n";
        chaos.server.put("staged/line-cap", body);

        await chaos.fake.request(
          "mutation R($mutation: String!, $stagedUploadPath: String!) { bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) { bulkOperation { id } } }",
          { mutation: "productVariantsBulkUpdate", stagedUploadPath: "staged/line-cap" },
        );
        let state: { status: string; url?: string | null } | undefined;
        for (let poll = 0; poll < 10 && state?.status !== "COMPLETED"; poll++) {
          const response = (await chaos.fake.request("query { currentBulkOperation(type: MUTATION) { id status url } }", {})) as {
            data?: { currentBulkOperation?: { status: string; url?: string | null } };
          };
          state = response.data?.currentBulkOperation;
        }
        expect(state?.status).toBe("COMPLETED");

        const results = (await (await fetch(state!.url!)).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { __lineNumber: number; errors?: Array<{ message: string }>; data?: unknown });
        expect(results.map((line) => line.__lineNumber), "lines are counted from zero, as Shopify counts them").toEqual([0, 1]);
        expect(results[0].errors?.[0]?.message).toMatch(/size of 251 is greater than the maximum allowed of 250/);
        expect(results[1].data).toBeDefined();

        // Refused whole: not the first 250 written and the last turned away.
        for (const gid of of(big)) expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
        expect(chaos.fake.priceOf(of(other)[0])).toBe("2.00");
      },
    );
  });
});
