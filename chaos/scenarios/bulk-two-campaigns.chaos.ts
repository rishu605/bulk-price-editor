/**
 * Two campaigns' bulk runs in one shop at once (#1054): two scheduled sales starting
 * together, or one sale's apply beside another's revert.
 *
 * Shopify runs a limited number of bulk mutations per app and shop at once -- five from API
 * version 2026-01, which this app pins (2026-07); one before that -- and refuses another
 * past the limit with a `LIMIT_REACHED` user error. The executor used to follow its
 * operation by asking for "the app's most recent one", `currentBulkOperation`, so with two
 * running the older run read the newer run's status and result file and settled its own
 * rows against somebody else's. And past the limit, a refused submission failed the run.
 *
 * The fake used to hold one operation and let a second replace the first, so none of this
 * could be tested. It now runs several, each with its own result file, up to
 * `bulkMutationLimit`.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { describeState } from "../../app/lib/lifecycle/transitions";
import { lifecycleContext } from "../../app/services/campaigns/lifecycle-context.server";
import { transitionHistory } from "../../app/services/campaigns/lifecycle.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";
import { judge } from "../harness/verdict";

const dollars = (minor: number) => (minor / 100).toFixed(2);

/** Two campaigns over the two halves of the fixture's catalogue, nothing shared. */
async function twoSales(chaos: ChaosContext) {
  const { shopId, variantGids } = chaos.fixture;
  const half = Math.ceil(variantGids.length / 2);
  const halves = { first: variantGids.slice(0, half), second: variantGids.slice(half) };
  for (const [tag, gids] of Object.entries(halves)) {
    await prisma.variantIndex.updateMany({ where: { shopId, variantGid: { in: gids } }, data: { tags: ["chaos", tag] } });
  }

  const sale = (name: string, tag: string, percent: number) =>
    createCampaign(shopId, {
      name,
      priority: 500,
      rule: { kind: "percent-change", percent },
      compareAtPolicy: { kind: "leave" },
      rounding: { default: "none", byCurrency: {} },
      ast: { groups: [{ conditions: [{ field: "tag", value: tag }] }] },
      schedule: { kind: "manual" },
    } as never);

  const spring = await sale("Spring sale", "first", -20);
  const clearance = await sale("Clearance", "second", -30);
  return {
    spring: { id: spring.id, variants: halves.first, factor: 0.8 },
    clearance: { id: clearance.id, variants: halves.second, factor: 0.7 },
  };
}

/** Waits for something the runs are doing in the background, or fails saying what. */
async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A run of one campaign ended verified-clean, over its own variants and no others. */
async function expectCleanAndOwn(
  chaos: ChaosContext,
  sale: { id: string; variants: string[]; factor: number },
  runId: string,
) {
  const verdict = await judge({ ...chaos.fixture, campaignId: sale.id }, chaos.fake, runId);
  expect(verdict.violations, `${sale.id}: the engine ended in a state it cannot justify`).toEqual([]);
  expect(verdict.outcome).toBe("clean");

  const ledger = await prisma.variantChange.findMany({ where: { runId }, orderBy: { variantGid: "asc" } });
  expect(ledger.map((row) => row.variantGid), "a run's ledger holds another campaign's rows").toEqual([...sale.variants].sort());
  expect(ledger.every((row) => row.status === "VERIFIED"), "a row was not read back verified").toBe(true);
  for (const gid of sale.variants) {
    expect(chaos.fake.priceOf(gid)).toBe(dollars(Math.round(chaos.fixture.baseline.get(gid)! * sale.factor)));
  }

  // Its own operation, followed to its own end.
  const operations = await prisma.bulkOperationRecord.findMany({ where: { runId, kind: "MUTATION" } });
  expect(operations).toHaveLength(1);
  expect(operations[0].status).toBe("COMPLETED");
  expect((await prisma.campaign.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("ACTIVE");
  return operations[0].shopifyGid;
}

const SPEC = { catalog: { products: 6, variantsPerProduct: 1 }, percent: -10 };

describe("chaos: two campaigns' bulk runs in one shop at once", () => {
  it("runs both side by side, each following its own operation to its own result file", async () => {
    await withChaos("bulk-two-campaigns", { ...SPEC, pollsBeforeComplete: 2 }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const { spring, clearance } = await twoSales(chaos);

      const run = (id: string) => runCampaign(shopId, id, client, { actor: "chaos", forcePath: "bulk", verifySampleRate: 1 });
      const [a, b] = await Promise.all([run(spring.id), run(clearance.id)]);

      expect(chaos.fake.bulkRefusals, "under the limit, Shopify refuses nothing").toBe(0);
      const opA = await expectCleanAndOwn(chaos, spring, a.runId);
      const opB = await expectCleanAndOwn(chaos, clearance, b.runId);
      expect(opA, "both runs claim the same operation").not.toBe(opB);
      expect(a.clean && b.clean).toBe(true);
    });
  });

  it("waits behind the other campaign's operation past the limit, says so, and both end verified-clean", async () => {
    await withChaos("bulk-two-campaigns-wait", { ...SPEC, pollsBeforeComplete: 1_000 }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const { spring, clearance } = await twoSales(chaos);
      // The stricter reading: one at a time, as before 2026-01. Five behave the same at six.
      chaos.fake.bulkMutationLimit = 1;

      const run = (id: string) => runCampaign(shopId, id, client, { actor: "chaos", forcePath: "bulk", verifySampleRate: 1 });
      const first = run(spring.id);
      await until("Spring sale's operation to be accepted", () =>
        prisma.bulkOperationRecord.findFirst({ where: { shopId, run: { campaignId: spring.id } } }),
      );
      const second = run(clearance.id);
      // Not awaited yet, and a rejection is not left unhandled while the page is read.
      second.catch(() => undefined);

      // Refused by Shopify, and waiting rather than failed.
      const waiting = await until("Clearance to record that it is waiting", async () => {
        const [latest] = await transitionHistory(shopId, clearance.id, 1);
        return latest?.reason.startsWith("Waiting behind") ? latest : null;
      });
      expect(chaos.fake.bulkRefusals).toBeGreaterThan(0);
      expect(waiting.reason).toMatch(/^Waiting behind "Spring sale", whose bulk price update is still running in Shopify\./);
      expect(waiting.reason).toMatch(/nothing has been written yet/i);
      expect(waiting.actor).toBe("chaos");

      // Its Status card says the same, not "Writing prices now".
      const card = describeState(
        "APPLYING",
        await lifecycleContext(shopId, clearance.id, "APPLYING", { schedule: { kind: "manual" }, practice: false }, "UTC", { outrankedBy: [] }),
      );
      expect(card.explanation).toBe(waiting.reason);
      expect(card.label).toMatch(/waiting/i);

      // Rule 2: the waiting run still holds its occurrence. It has sent nothing, and a second
      // Apply defers to it rather than starting a second writer.
      const live = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId: clearance.id } });
      expect(live.status).toBe("EXECUTING");
      expect(await prisma.bulkOperationRecord.count({ where: { runId: live.id } })).toBe(0);
      expect((await prisma.variantChange.findMany({ where: { runId: live.id } })).every((row) => row.status === "PENDING")).toBe(true);
      const again = await run(clearance.id);
      expect(again.deferredTo, "a second Apply started a second writer").toBe(live.id);

      // Spring sale's operation finishes; Clearance's goes in behind it.
      chaos.fake.finishBulkOnNextPoll();
      const [a, b] = await Promise.all([first, second]);
      const opA = await expectCleanAndOwn(chaos, spring, a.runId);
      const opB = await expectCleanAndOwn(chaos, clearance, b.runId);
      expect(opA).not.toBe(opB);
      expect(b.runId).toBe(live.id);

      // Once it is running, the card stops saying it is waiting.
      const after = await lifecycleContext(shopId, clearance.id, "APPLYING", { schedule: { kind: "manual" }, practice: false }, "UTC", { outrankedBy: [] });
      expect(after.waitingBehind ?? null).toBeNull();
    });
  });

  it("gives up waiting after its wait, having sent nothing, and says nothing changed", async () => {
    await withChaos("bulk-two-campaigns-gives-up", { ...SPEC, pollsBeforeComplete: 1_000 }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const { spring, clearance } = await twoSales(chaos);
      chaos.fake.bulkMutationLimit = 1;

      const first = runCampaign(shopId, spring.id, client, { actor: "chaos", forcePath: "bulk", verifySampleRate: 1 });
      await until("Spring sale's operation to be accepted", () =>
        prisma.bulkOperationRecord.findFirst({ where: { shopId, run: { campaignId: spring.id } } }),
      );

      const thrown = await runCampaign(shopId, clearance.id, client, {
        actor: "chaos",
        forcePath: "bulk",
        verifySampleRate: 1,
        bulkWaitMs: 1,
      }).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(Error);

      // Nothing was sent, so nothing is Partial: the run failed before writing, its rows were
      // never attempted, and the campaign is back where it was with the reason.
      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId: clearance.id } });
      expect(run.status).toBe("FAILED");
      expect((await prisma.variantChange.findMany({ where: { runId: run.id } })).every((row) => row.status === "PENDING")).toBe(true);
      for (const gid of clearance.variants) expect(chaos.fake.priceOf(gid)).toBe(dollars(chaos.fixture.baseline.get(gid)!));
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: clearance.id } })).status).toBe("DRAFT");
      const [released] = await transitionHistory(shopId, clearance.id, 1);
      expect(released.reason).toMatch(/still running other bulk price updates/);
      expect(released.reason).toMatch(/No prices were changed/);
      expect(released.reason).not.toMatch(/may have changed/);

      // Spring sale was never disturbed, and Clearance applies once it is done.
      chaos.fake.finishBulkOnNextPoll();
      await expectCleanAndOwn(chaos, spring, (await first).runId);
      const retried = await runCampaign(shopId, clearance.id, client, { actor: "chaos", forcePath: "bulk", verifySampleRate: 1 });
      await expectCleanAndOwn(chaos, clearance, retried.runId);
    });
  });
});
