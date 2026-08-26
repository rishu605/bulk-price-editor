#!/usr/bin/env node
/**
 * The mirror-corruption drill: break the mirror on purpose, prove the app notices.
 *
 *   npx tsx scripts/drill-mirror.ts --shop anchor-perf
 *
 * `mirror-audit.chaos.ts` proves the same behaviour against the fake. This proves it
 * against a real store and a real Shopify, which is a different claim — the chaos harness
 * cannot tell you that the live read path, the session, the rate limiter and the healing
 * write all work together on a catalogue of a hundred thousand variants.
 *
 * **The audit samples randomly, and that decides how this drill has to be shaped.** A
 * first attempt corrupted twenty rows out of 102,132 and found nothing, which looked like
 * a broken audit and was actually a broken drill: a sample of twenty will essentially
 * never reach twenty specific rows. So it corrupts a *fraction* — enough that a sample is
 * expected to hit it, and far enough over the alert threshold that the alert must fire.
 *
 * **It restores what it broke.** Every corrupted row the audit did not reach is put back
 * from the values captured before, so a drill never leaves a store's mirror worse than it
 * found it. That matters more than it sounds: the rows it does not heal are, by
 * definition, the ones nobody is watching.
 */

import prisma from "../app/db.server";
import { adminClientForShop } from "../app/services/admin-client.server";
import { auditMirror } from "../app/services/mirror-audit.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";

/** Corrupt this share of the catalogue. Well over the 0.5% alert threshold. */
const CORRUPT_SHARE = 0.03;
/** How many rows the dirty audit samples. Big enough to expect several hits. */
const SAMPLE = 400;
/** How far each corrupted price is pushed, in minor units. */
const OFFSET = 1_000n;

export interface DrillResult {
  corrupted: number;
  checked: number;
  diverged: number;
  healed: number;
  ratePercent: number;
  alerted: boolean;
  restored: number;
}

/** What the drill proved, or did not. */
export function verdict(result: DrillResult): string[] {
  const lines: string[] = [];

  lines.push(
    result.diverged > 0
      ? `PASS  detected ${result.diverged} of ${result.checked} sampled as diverged`
      : `FAIL  sampled ${result.checked} rows and found no divergence, having corrupted ${result.corrupted}`,
  );

  lines.push(
    result.healed === result.diverged && result.diverged > 0
      ? `PASS  healed all ${result.healed} it found`
      : `FAIL  found ${result.diverged} but healed ${result.healed}`,
  );

  lines.push(
    result.alerted
      ? `PASS  alerted at ${result.ratePercent.toFixed(2)}% divergence`
      : `FAIL  ${result.ratePercent.toFixed(2)}% divergence did not raise an alert`,
  );

  // Always reported, because a drill that leaves damage behind is worse than no drill.
  lines.push(`      restored ${result.restored} rows the sample never reached`);
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true, domain: true },
    orderBy: { domain: "asc" },
  });
  const target = chooseShop(installed, shopArg(args));
  const shopId = installed.find((shop) => shop.domain === target.domain)!.id;

  const client = await adminClientForShop(target.domain);
  if (!client) {
    throw new Error(`No usable session for ${target.domain}. Open the app in the admin first.`);
  }

  console.log(`Drilling ${target.domain}\n`);

  // A clean baseline first. Divergence found before anything is injected would make
  // everything after it meaningless.
  const before = await auditMirror(client, shopId, { size: 60 });
  console.log(`  clean audit   checked=${before.checked} diverged=${before.diverged}`);
  if (before.diverged > 0) {
    console.log("\n  The mirror was already diverged. Fix that before drilling — this run\n" +
      "  cannot tell its own damage from what was already there.");
    await prisma.$disconnect();
    return;
  }

  const total = await prisma.variantIndex.count({ where: { shopId, deletedAt: null } });
  const victims = await prisma.variantIndex.findMany({
    where: { shopId, deletedAt: null, price: { not: null } },
    select: { variantGid: true, price: true },
    take: Math.max(1, Math.round(total * CORRUPT_SHARE)),
    orderBy: { variantGid: "asc" },
  });
  const original = new Map(victims.map((row) => [row.variantGid, row.price!]));

  for (const row of victims) {
    await prisma.variantIndex.update({
      where: { shopId_variantGid: { shopId, variantGid: row.variantGid } },
      data: { price: row.price! + OFFSET },
    });
  }
  console.log(`  corrupted     ${victims.length} of ${total} rows`);

  const after = await auditMirror(client, shopId, { size: SAMPLE });
  console.log(`  dirty audit   checked=${after.checked} diverged=${after.diverged} healed=${after.healed}`);

  const stillWrong = await prisma.variantIndex.findMany({
    where: { shopId, variantGid: { in: victims.map((row) => row.variantGid) } },
    select: { variantGid: true, price: true },
  });
  const unhealed = stillWrong.filter((row) => row.price !== original.get(row.variantGid));

  for (const row of unhealed) {
    await prisma.variantIndex.update({
      where: { shopId_variantGid: { shopId, variantGid: row.variantGid } },
      data: { price: original.get(row.variantGid)! },
    });
  }

  console.log(
    `\n${verdict({
      corrupted: victims.length,
      checked: after.checked,
      diverged: after.diverged,
      healed: after.healed,
      ratePercent: after.rate * 100,
      alerted: after.alert,
      restored: unhealed.length,
    }).join("\n")}\n`,
  );

  await prisma.$disconnect();
}

if (process.argv[1]?.includes("drill-mirror")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
