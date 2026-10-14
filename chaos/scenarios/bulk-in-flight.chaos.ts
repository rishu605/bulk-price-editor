/**
 * A bulk run's prices are "sent to Shopify" from the moment Shopify accepts them (#832).
 *
 * On anchor-perf a 100,139-row bulk apply read "100139 still to run. Nothing has been
 * written." for over an hour while Shopify was applying every one of those prices. Rows
 * stayed Pending until the result file was reconciled at the very end; a process that
 * stopped while polling left them looking never-sent, and the reaper said "the rest are
 * unchanged". Shopify goes on applying a bulk operation after the app stops watching.
 *
 * Driven through the run path on the bulk path against the fake store, which keeps the
 * operation running until told to finish.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { listCampaigns } from "../../app/services/campaigns/list.server";
import { reclaimStaleRuns } from "../../app/services/campaigns/reaper.server";
import { campaignResult } from "../../app/services/campaigns/result.server";
import { isBulkPoll } from "../harness/faults";
import { withChaos } from "../harness/scenario";

const dollars = (minor: number) => (minor / 100).toFixed(2);

const SPEC = { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20, pollsBeforeComplete: 1_000 };

describe("chaos: a bulk run whose process stops after Shopify accepted the operation", () => {
  it("leaves its rows sent, says so, and a resume asks Shopify how the operation ended before sending again", async () => {
    await withChaos("bulk-in-flight", { ...SPEC, tagKit: ["SALE"] }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline, productOf } = chaos.fixture;

      // Shopify accepts the operation; then the run loses its polling for good.
      chaos.arm([{ fault: "server-error", match: (query) => isBulkPoll(query), after: 1 }]);
      const thrown = await chaos.apply({ forcePath: "bulk" }).catch((error: unknown) => error);
      chaos.heal();
      expect(thrown).toBeInstanceOf(Error);

      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "APPLY" } });
      const statuses = await prisma.variantChange.findMany({ where: { runId: run.id }, select: { status: true } });
      expect(statuses.map((row) => row.status), "rows Shopify is applying read as never sent").toEqual(variantGids.map(() => "WRITING"));
      const operation = await prisma.bulkOperationRecord.findFirstOrThrow({ where: { runId: run.id } });
      expect(operation.status).toBe("RUNNING");

      const summary = (await campaignResult(shopId, run.id))!.summary;
      expect(summary, "the run said nothing had been written").not.toMatch(/Nothing has been written/);
      expect(summary).toMatch(/^4 sent to Shopify; their results arrive when the bulk operation finishes/);
      const listed = (filters = { q: "", status: "" as const, archived: false, page: 1 }) =>
        listCampaigns(shopId, filters).then((list) => list.campaigns.find((row) => row.id === campaignId)!.lastRun);
      expect((await listed())?.atShopify, "the list read 0 verified while Shopify applied them").toEqual({ done: 0, of: 4, live: false });

      // The reaper, finding the same run an hour after its process died, says what it knows.
      await prisma.campaignRun.update({ where: { id: run.id }, data: { status: "EXECUTING" } });
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "APPLYING" } });
      const reaped = await reclaimStaleRuns(new Date(Date.now() + 3_600_000), 60_000);
      expect(reaped.runIds).toContain(run.id);
      expect((await prisma.variantChange.findMany({ where: { runId: run.id } })).every((row) => row.status === "WRITING")).toBe(true);
      const reason = (
        await prisma.auditLogEntry.findFirstOrThrow({
          where: { shopId, entityId: campaignId, action: "campaign.transition" },
          orderBy: { createdAt: "desc" },
        })
      ).after as { reason: string };
      expect(reason.reason, "the reaper called sent prices unchanged").toMatch(
        new RegExp(`still running its bulk operation ${operation.shopifyGid}\\. 4 prices were sent to Shopify and may already be live`),
      );

      // Resume while Shopify is still at it: it waits, and sends nothing. Any attempt to
      // stage a second upload fails at once, rather than polling a resent operation
      // the fake would never finish.
      const operationsBefore = await prisma.bulkOperationRecord.count({ where: { shopId } });
      chaos.arm([{ fault: "auth-revoked", match: (query) => query.includes("stagedUploadsCreate") }]);
      const held = await chaos.apply({ resume: true, forcePath: "bulk" });
      expect(held.refused).toMatch(/^Shopify is still applying this campaign's prices in bulk/);
      expect(held.transient).toBe(true);
      expect(await prisma.bulkOperationRecord.count({ where: { shopId } }), "a resume sent the rows again").toBe(operationsBefore);

      // Shopify finishes. The resume settles those rows from its result file and has
      // nothing left to send (so it is not forced down the bulk path, which refuses an
      // empty set).
      chaos.fake.finishBulkOnNextPoll();
      const finished = await chaos.apply({ resume: true });
      expect((await prisma.variantChange.findMany({ where: { runId: run.id } })).map((row) => row.status)).toEqual(
        variantGids.map(() => "VERIFIED"),
      );
      // This run's own counts are zero; it says what it read rather than "0 verified".
      expect(finished.messages[0]).toBe(
        `Shopify had finished bulk operation ${operation.shopifyGid}: 4 price(s) read back from its result file.`,
      );
      expect(await prisma.bulkOperationRecord.count({ where: { shopId } })).toBe(operationsBefore);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(dollars(Math.round(baseline.get(gid)! * 0.8)));
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");
      expect((await listed())?.atShopify).toBeNull();
      // Tags come after prices, and the run that sent them died first. The resume owes
      // those products their tags though it writes none of their prices.
      for (const gid of variantGids) expect(chaos.fake.tagsOf(productOf.get(gid)!), "a settled product was never tagged").toContain("SALE");
      chaos.heal();
    });
  });

  it("holds a revert until Shopify has finished applying, so the apply cannot land on top of it", async () => {
    await withChaos("bulk-in-flight-revert", SPEC, async (chaos) => {
      const { campaignId, variantGids, baseline } = chaos.fixture;

      chaos.arm([{ fault: "server-error", match: (query) => isBulkPoll(query), after: 1 }]);
      await chaos.apply({ forcePath: "bulk" }).catch(() => undefined);
      chaos.heal();

      // A revert written now would be overwritten as Shopify works through the apply,
      // leaving the store discounted under a campaign that says it ended.
      const held = await chaos.revert();
      expect(held.refused, "a revert wrote while Shopify was still applying").toMatch(/^Shopify is still applying this campaign's prices in bulk/);
      expect(held.transient).toBe(true);
      expect(await prisma.campaignRun.count({ where: { campaignId, kind: "REVERT" } })).toBe(0);

      // Once it finishes, the revert settles the apply's rows and recomputes from there.
      chaos.fake.finishBulkOnNextPoll();
      const reverted = await chaos.revert();
      expect(reverted.refused).toBeUndefined();
      const apply = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "APPLY" } });
      expect(await prisma.variantChange.count({ where: { runId: apply.id, status: "WRITING" } })).toBe(0);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(dollars(baseline.get(gid)!));
    });
  });

  it("settles a run that died reading the result file of an operation Shopify had finished", async () => {
    await withChaos("bulk-in-flight-unread", { ...SPEC, pollsBeforeComplete: 1 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;

      chaos.server.resultFilesDown = true;
      const thrown = await chaos.apply({ forcePath: "bulk" }).catch((error: unknown) => error);
      chaos.server.resultFilesDown = false;
      expect(thrown).toBeInstanceOf(Error);

      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "APPLY" } });
      expect(
        (await prisma.variantChange.findMany({ where: { runId: run.id } })).map((row) => row.status),
        "rows Shopify had applied went back to never sent",
      ).toEqual(variantGids.map(() => "WRITING"));
      const operation = await prisma.bulkOperationRecord.findFirstOrThrow({ where: { runId: run.id } });
      expect(operation.status).toBe("COMPLETED");
      expect((await campaignResult(shopId, run.id))!.summary).toBe(
        "4 sent to Shopify, whose bulk operation has finished. None is read back yet.",
      );

      // The reaper, finding it in that state from a dead process, keeps the rows sent.
      await prisma.campaignRun.update({ where: { id: run.id }, data: { status: "EXECUTING" } });
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "APPLYING" } });
      expect((await reclaimStaleRuns(new Date(Date.now() + 3_600_000), 60_000)).runIds).toContain(run.id);
      expect(await prisma.variantChange.count({ where: { runId: run.id, status: "WRITING" } })).toBe(variantGids.length);
      const reason = (
        await prisma.auditLogEntry.findFirstOrThrow({
          where: { shopId, entityId: campaignId, action: "campaign.transition" },
          orderBy: { createdAt: "desc" },
        })
      ).after as { reason: string };
      expect(reason.reason).toContain(`after Shopify finished its bulk operation ${operation.shopifyGid}, before its results were read`);

      // The resume reads the finished operation's results instead of sending 4 prices again.
      chaos.arm([{ fault: "auth-revoked", match: (query) => query.includes("stagedUploadsCreate") }]);
      await chaos.apply({ resume: true });
      chaos.heal();
      expect((await prisma.variantChange.findMany({ where: { runId: run.id } })).map((row) => row.status)).toEqual(
        variantGids.map(() => "VERIFIED"),
      );
      expect(await prisma.bulkOperationRecord.count({ where: { shopId } })).toBe(1);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(dollars(Math.round(baseline.get(gid)! * 0.8)));
    });
  });

  it("leaves an operation to the live run that sent it, even once Shopify has finished", async () => {
    await withChaos("bulk-in-flight-live", SPEC, async (chaos) => {
      const { campaignId, variantGids } = chaos.fixture;

      chaos.arm([{ fault: "server-error", match: (query) => isBulkPoll(query), after: 1 }]);
      await chaos.apply({ forcePath: "bulk" }).catch(() => undefined);
      chaos.heal();

      // As far as the database knows, the run that sent it is still polling: its rows are
      // its own to settle. Settling them from here would be a second writer of that run.
      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "APPLY" } });
      await prisma.campaignRun.update({ where: { id: run.id }, data: { status: "EXECUTING" } });
      chaos.fake.finishBulkOnNextPoll();

      const scoped = await chaos.revert({ variantGids: [variantGids[0]] });
      expect(scoped.refused, "a scoped run settled a live run's rows").toMatch(/^Shopify is still applying this campaign's prices in bulk/);
      expect(await prisma.variantChange.count({ where: { runId: run.id, status: "WRITING" } })).toBe(variantGids.length);
      expect((await prisma.bulkOperationRecord.findFirstOrThrow({ where: { runId: run.id } })).status).toBe("RUNNING");
    });
  });

  it("keeps the rows sent when Shopify outlasts the run's wait, rather than settling them unreported", async () => {
    await withChaos("bulk-in-flight-wait", SPEC, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;

      // The poll gives up while Shopify is still working. This used to settle every row as
      // "Not present in the bulk result file", and a resume then sent them all again.
      const thrown = await chaos.apply({ forcePath: "bulk", bulkWaitMs: 1 }).catch((error: unknown) => error);
      expect((thrown as { userMessage?: string }).userMessage).toMatch(
        /^This apply stopped part-way\. 4 prices were sent to Shopify in bulk and may already be live\./,
      );
      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "APPLY" } });
      expect(
        (await prisma.variantChange.findMany({ where: { runId: run.id } })).map((row) => row.status),
        "rows Shopify was still applying were settled as unreported",
      ).toEqual(variantGids.map(() => "WRITING"));
      expect((await campaignResult(shopId, run.id))!.summary).toMatch(/^4 sent to Shopify; /);

      chaos.fake.finishBulkOnNextPoll();
      chaos.arm([{ fault: "auth-revoked", match: (query) => query.includes("stagedUploadsCreate") }]);
      await chaos.apply({ resume: true });
      chaos.heal();
      expect((await prisma.variantChange.findMany({ where: { runId: run.id } })).map((row) => row.status)).toEqual(
        variantGids.map(() => "VERIFIED"),
      );
      expect(await prisma.bulkOperationRecord.count({ where: { shopId } })).toBe(1);
    });
  });

  it("settles a clamped row as clamped, with its reason, not as the rule's own price", async () => {
    await withChaos("bulk-in-flight-clamped", SPEC, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const [cheap, ...rest] = variantGids;

      // $5 off a $3 product: priced at the smallest price instead (#792).
      chaos.fake.variants.get(cheap)!.price = "3.00";
      chaos.fixture.baseline.set(cheap, 300);
      await prisma.baseline.updateMany({ where: { shopId, variantGid: cheap, supersededAt: null }, data: { basePrice: 300n } });
      await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid: cheap, surfaceKind: "BASE" }, data: { livePrice: 300n } });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { ruleRows: [{ segmentIds: [], rule: { kind: "fixed-change", amount: { amount: -500, currency: "USD" } } }] as never },
      });

      chaos.arm([{ fault: "server-error", match: (query) => isBulkPoll(query), after: 1 }]);
      await chaos.apply({ forcePath: "bulk" }).catch(() => undefined);
      chaos.heal();

      chaos.fake.finishBulkOnNextPoll();
      await chaos.apply({ resume: true });
      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId, kind: "APPLY" }, orderBy: { createdAt: "asc" } });
      const ledger = new Map(
        (await prisma.variantChange.findMany({ where: { runId: run.id } })).map((row) => [row.variantGid, row]),
      );
      expect(ledger.get(cheap), "a clamped row settled as the rule's own price").toMatchObject({ status: "CLAMPED", intendedPrice: 1n });
      expect(ledger.get(cheap)!.failureReason).toMatch(/smallest price: the rule would have priced it at zero or below/);
      expect(ledger.get(cheap)!.appliedAt).not.toBeNull();
      for (const gid of rest) expect(ledger.get(gid)).toMatchObject({ status: "VERIFIED", failureReason: null });
      expect(chaos.fake.priceOf(cheap)).toBe("0.01");
    });
  });
});
