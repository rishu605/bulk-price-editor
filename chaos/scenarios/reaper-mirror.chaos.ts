/**
 * A reclaimed run leaves the mirror saying what it may have written (#903).
 *
 * A run whose process dies mid-write is reclaimed by the reaper: run and campaign go to
 * Partial. The mirror was only refreshed by a run that finished, so every variant the dead
 * run had written still read its pre-run price. A Revert from Partial plans against the
 * mirror, so it found those variants "already at baseline", wrote nothing for them and
 * reported clean with the sale still live. #802 fixed this for a run that throws; the
 * reaper is the other way a run stops mid-write.
 *
 * SIGKILL, in a real child process, timed off writes the store has actually accepted.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { tick } from "../../app/services/scheduler.server";
import { withChaos } from "../harness/scenario";
import { killAfterWrites, startApply } from "../harness/worker-process";

const LATER = () => new Date(Date.now() + 60 * 60_000);
const minor = (price: string | undefined) => (price === undefined ? undefined : Math.round(Number(price) * 100));

describe("chaos: the reaper reclaims a run that died mid-write", () => {
  it("settles the mirror from the ledger, so a Revert from Partial puts every price back", async () => {
    await withChaos("reaper-mirror", { catalog: { products: 60, variantsPerProduct: 1 }, percent: -25 }, async (chaos) => {
      const { shopId, campaignId, variantGids, baseline } = chaos.fixture;

      const child = startApply({ endpoint: chaos.server.endpoint(), shopId, campaignId });
      const writesBefore = chaos.fake.writeLog.length;
      await killAfterWrites(chaos.server, child, writesBefore + 3);
      expect(child.killed()).toBe(true);

      const moved = variantGids.filter((gid) => minor(chaos.fake.priceOf(gid)) !== baseline.get(gid));
      expect(moved.length, "the kill landed before any write").toBeGreaterThan(0);

      await tick(LATER());
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("PARTIAL");

      // Nothing the store moved may still read its pre-run price: it is the price the
      // store shows, or unknown.
      const mirror = new Map(
        (await prisma.priceSurfaceEntry.findMany({ where: { shopId, surfaceKind: "BASE", variantGid: { in: variantGids } } })).map(
          (entry) => [entry.variantGid, entry.livePrice === null ? null : Number(entry.livePrice)],
        ),
      );
      for (const gid of moved) {
        expect(mirror.get(gid), `${gid} still reads its pre-run price after the reclaim`).not.toBe(baseline.get(gid));
      }

      const reverted = await chaos.revert();
      await chaos.expectHonest(reverted.runId);
      for (const gid of variantGids) {
        expect(minor(chaos.fake.priceOf(gid)), `${gid} kept the sale price after the revert`).toBe(baseline.get(gid));
      }
    });
  });
});
