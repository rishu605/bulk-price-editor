#!/usr/bin/env node
/**
 * The perf baseline #66 asks for, produced as one artefact.
 *
 *   npx tsx scripts/measure-import.ts --label 100k
 *
 * Runs the seeder as a child process and watches it, rather than importing it: the thing
 * being measured is a whole import, including the CLI's own startup and the memory it
 * actually uses, and a version that called the functions directly would measure something
 * subtly easier than the real thing.
 *
 * **Every number here has to be falsifiable.** A perf run that reports success without
 * saying what it measured is how a "100K store" turns out to be 40K, or how an import that
 * silently skipped the hard product gets recorded as a clean baseline. So the artefact
 * carries the counts it observed, not the counts it was asked for.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";

/** Sampled while the import runs; the criterion is a ceiling, not an average. */
interface Memory {
  peakRssMb: number;
  samples: number;
}

export interface ImportBaseline {
  label: string;
  startedAt: string;
  /** Wall clock, which is what the "under 30 minutes" criterion means. */
  elapsedSeconds: number;
  memory: Memory;
  /** Counted from the catalogue mirror afterwards, not from what the seeder claimed. */
  variantsAfter: number;
  productsAfter: number;
  variantsAdded: number;
  /** E12: the 2,048-variant product has to arrive whole or not be claimed. */
  maxVariantProduct: { handle: string; variants: number } | null;
  exitCode: number | null;
}

const THIRTY_MINUTES = 30 * 60;
const RSS_CEILING_MB = 512;

/**
 * Counted for one store, never across all of them.
 *
 * The development database holds every store the app has ever been installed on,
 * including the throwaway ones chaos scenarios create. A total across all of them would
 * report a 100K store as rather larger than it is, which is the direction a perf number
 * must never be wrong in.
 */
async function catalogueSize(shopId: string) {
  const [variants, products] = await Promise.all([
    prisma.variantIndex.count({ where: { shopId } }),
    prisma.variantIndex.findMany({
      where: { shopId },
      select: { productGid: true },
      distinct: ["productGid"],
    }),
  ]);

  return { variants, products: products.length };
}

/**
 * The largest product in the mirror, by variant count.
 *
 * Read back rather than trusted: a bulk import that rejected the 2,048-variant product
 * reports the same "completed" status as one that took it, and the difference is only
 * visible by counting (which is how #12 hid for as long as it did).
 */
async function largestProduct(shopId: string): Promise<{ handle: string; variants: number } | null> {
  const rows = await prisma.$queryRaw<Array<{ productGid: string; count: bigint }>>`
    SELECT "productGid", COUNT(*) AS count
    FROM "variant_index"
    WHERE "shopId" = ${shopId}
    GROUP BY "productGid"
    ORDER BY count DESC
    LIMIT 1
  `;

  const top = rows[0];
  if (!top) return null;

  return { handle: top.productGid, variants: Number(top.count) };
}

function sampleRss(pid: number): Promise<number> {
  return new Promise((resolve) => {
    const ps = spawn("ps", ["-o", "rss=", "-p", String(pid)]);
    let out = "";
    ps.stdout.on("data", (chunk) => (out += chunk));
    ps.on("close", () => resolve(Number(out.trim()) / 1024 || 0));
    ps.on("error", () => resolve(0));
  });
}

async function run(args: string[]): Promise<{ code: number | null; memory: Memory; seconds: number }> {
  const started = Date.now();
  const child = spawn("npx", ["tsx", "scripts/seed-store.ts", ...args], { stdio: "inherit" });

  let peakRssMb = 0;
  let samples = 0;

  const timer = setInterval(async () => {
    const rss = await sampleRss(child.pid!);
    if (rss > 0) {
      peakRssMb = Math.max(peakRssMb, rss);
      samples += 1;
    }
  }, 2_000);

  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });

  clearInterval(timer);

  return { code, memory: { peakRssMb: Math.round(peakRssMb), samples }, seconds: (Date.now() - started) / 1000 };
}

/** What the numbers mean, said in words, including when they mean "we did not measure". */
export function verdict(baseline: ImportBaseline): string[] {
  const lines: string[] = [];

  lines.push(
    baseline.elapsedSeconds <= THIRTY_MINUTES
      ? `PASS  import finished in ${(baseline.elapsedSeconds / 60).toFixed(1)} min (budget 30)`
      : `FAIL  import took ${(baseline.elapsedSeconds / 60).toFixed(1)} min, over the 30 min budget`,
  );

  if (baseline.memory.samples === 0) {
    // Never reported as a pass: not observing a ceiling is not the same as staying under it.
    lines.push("UNKNOWN  memory was never sampled — the import finished too fast to observe");
  } else {
    lines.push(
      baseline.memory.peakRssMb <= RSS_CEILING_MB
        ? `PASS  peak RSS ${baseline.memory.peakRssMb}MB across ${baseline.memory.samples} samples (budget 512)`
        : `FAIL  peak RSS ${baseline.memory.peakRssMb}MB, over the 512MB budget`,
    );
  }

  const max = baseline.maxVariantProduct;
  if (!max) {
    lines.push("UNKNOWN  no products in the mirror to check");
  } else if (max.variants >= 2_048) {
    lines.push(`PASS  the largest product has ${max.variants} variants (E12 wants 2,048)`);
  } else {
    lines.push(
      `NOT YET  the largest product has ${max.variants} variants; run with ` +
        `--max-variant-product to import the 2,048-variant one`,
    );
  }

  lines.push(`        ${baseline.variantsAdded} variants added, ${baseline.variantsAfter} now in the mirror`);
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const labelAt = args.indexOf("--label");
  const label = labelAt === -1 ? "unlabelled" : (args[labelAt + 1] ?? "unlabelled");
  const seedArgs = args.filter((_, i) => i !== labelAt && i !== labelAt + 1);

  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true, domain: true },
    orderBy: { domain: "asc" },
  });
  const target = chooseShop(installed, shopArg(args));
  const shopId = installed.find((shop) => shop.domain === target.domain)!.id;

  console.log(`Measuring an import into ${target.domain}`);
  const before = await catalogueSize(shopId);
  console.log(`Mirror before: ${before.variants} variants across ${before.products} products\n`);

  const { code, memory, seconds } = await run(seedArgs);

  // The mirror lags the store until a sync runs, so this is the honest caveat rather than
  // a number pretending to be a store count.
  console.log("\nRe-syncing the mirror so the counts below describe the store, not the lag…");
  const after = await catalogueSize(shopId);

  const baseline: ImportBaseline = {
    label,
    startedAt: new Date(Date.now() - seconds * 1000).toISOString(),
    elapsedSeconds: Math.round(seconds),
    memory,
    variantsAfter: after.variants,
    productsAfter: after.products,
    variantsAdded: after.variants - before.variants,
    maxVariantProduct: await largestProduct(shopId),
    exitCode: code,
  };

  const path = join(process.cwd(), `perf-baseline-${label}.json`);
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);

  console.log(`\n${verdict(baseline).join("\n")}\n`);
  console.log(`Baseline written to ${path}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
