/**
 * The assertion the whole suite exists for.
 *
 * Note what is deliberately *not* asserted: that the run succeeded. Under a 429 storm
 * or a mid-run deletion it should not, and a harness that demanded success would push
 * the engine toward optimistic reporting -- the exact defect the category is full of.
 *
 * What is asserted is that the final state is one of two honest things:
 *
 *   VERIFIED CLEAN    every row read back and confirmed against the live store, or
 *   VISIBLY PARTIAL   some rows outstanding, each with a reason, the campaign showing
 *                     PARTIAL rather than ACTIVE, and a resume able to pick them up.
 *
 * There is no third outcome. A run that believes something untrue about the merchant's
 * storefront -- a VERIFIED row whose live price disagrees, a COMPLETED run with
 * unfinished work, a price written with no ledger row behind it -- fails here, and the
 * violation names the variant so the failure is diagnosable rather than merely red.
 */

import prisma from "../../app/db.server";
import type { FakeShopify } from "./fake-shopify";
import type { Fixture } from "./seed";

export type Outcome = "clean" | "partial";

export interface Verdict {
  ok: boolean;
  outcome: Outcome;
  violations: string[];
  counts: Record<string, number>;
}

/** Rows the merchant does not have to act on; settled, not outstanding. */
const SETTLED = new Set(["VERIFIED", "SKIPPED", "REVERTED"]);

export async function judge(
  fixture: Fixture,
  fake: FakeShopify,
  runId: string,
): Promise<Verdict> {
  const violations: string[] = [];

  const run = await prisma.campaignRun.findUniqueOrThrow({ where: { id: runId } });
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: fixture.campaignId },
    select: { status: true },
  });
  const rows = await prisma.variantChange.findMany({ where: { runId } });

  // Every ledger row on the shop, not just this run's. I4 says no price is written
  // without a row committed first -- it says nothing about which run owns it, and a
  // scenario that applies then reverts then reverts one variant has writes spread
  // across several runs. Checking one run's rows against every write ever made
  // reported the earlier runs' perfectly-ledgered writes as violations.
  const everLedgered = new Set(
    (
      await prisma.variantChange.findMany({
        where: { shopId: fixture.shopId },
        select: { variantGid: true },
        distinct: ["variantGid"],
      })
    ).map((row) => row.variantGid),
  );

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;

  // ------------------------------------------------- 1. no silently-wrong row
  //
  // The one that matters. A row marked VERIFIED asserts a specific price is live in
  // Shopify; if the store disagrees, the app is lying to the merchant, and every
  // downstream promise -- revert, overlap resolution, reconciliation -- is built on
  // that lie. This also catches a double-apply, since applying twice moves the live
  // price off the intended value computed from the baseline.
  for (const row of rows) {
    if (row.status !== "VERIFIED") continue;

    const live = fake.priceOf(row.variantGid);
    if (row.intendedPrice === null) continue;

    if (live === undefined) {
      violations.push(
        `${row.variantGid} is VERIFIED but does not exist in the store.`,
      );
      continue;
    }

    const liveMinor = Math.round(Number(live) * 100);
    if (liveMinor !== Number(row.intendedPrice)) {
      violations.push(
        `${row.variantGid} is VERIFIED at ${row.intendedPrice} minor units ` +
          `but the store says ${liveMinor}.`,
      );
    }
  }

  // ------------------------------------- 2. ledger before write (invariant I4)
  //
  // Every price the store accepted must have had a row committed first. A write with
  // no ledger row is a storefront change we cannot explain, attribute or revert.
  for (const write of fake.writeLog) {
    if (!everLedgered.has(write.variantGid)) {
      violations.push(
        `${write.variantGid} was written to the store with no ledger row behind it (I4).`,
      );
    }
  }

  // --------------------------------------- 3. the two outcomes, and no others
  const outstanding = rows.filter((row) => !SETTLED.has(row.status));
  const outcome: Outcome = run.status === "COMPLETED" ? "clean" : "partial";

  if (run.status === "COMPLETED") {
    if (outstanding.length > 0) {
      violations.push(
        `Run is COMPLETED with ${outstanding.length} unfinished rows ` +
          `(${[...new Set(outstanding.map((r) => r.status))].join(", ")}).`,
      );
    }
    if (campaign.status !== "ACTIVE" && campaign.status !== "COMPLETED") {
      violations.push(`Run completed but the campaign shows ${campaign.status}.`);
    }
  } else {
    if (run.status !== "PARTIAL" && run.status !== "FAILED") {
      violations.push(
        `Run ended in ${run.status}, which is neither clean nor visibly partial.`,
      );
    }
    if (campaign.status === "ACTIVE") {
      violations.push(
        "Run did not complete but the campaign reports ACTIVE -- a partial state must be visible.",
      );
    }

    // Every outstanding row must say why, or a resume has nothing to act on and the
    // merchant has nothing to read.
    for (const row of outstanding) {
      if (row.status === "PENDING") continue; // never attempted; resumable by design
      if (!row.failureReason) {
        violations.push(`${row.variantGid} is ${row.status} with no reason recorded.`);
      }
    }
  }

  // ------------------------------------------ 4. finished runs are finished
  if (run.finishedAt === null && (run.status === "COMPLETED" || run.status === "PARTIAL")) {
    violations.push(`Run is ${run.status} but has no finishedAt.`);
  }

  return { ok: violations.length === 0, outcome, violations, counts };
}

/**
 * Asserts convergence: two runs that should agree, do.
 *
 * Used by the interruption scenarios, where the point is not that the resumed run
 * succeeded but that it landed on precisely the state an uninterrupted run produces.
 */
export function convergenceViolations(
  expected: Map<string, string | undefined>,
  actual: Map<string, string | undefined>,
): string[] {
  const violations: string[] = [];
  for (const [variantGid, price] of expected) {
    const found = actual.get(variantGid);
    if (found !== price) {
      violations.push(
        `${variantGid} did not converge: expected ${price ?? "(absent)"}, found ${found ?? "(absent)"}.`,
      );
    }
  }
  return violations;
}
