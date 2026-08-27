/**
 * Runs the reconciliation spot check against the real store.
 *
 * The acceptance criterion for P5.6 is that a large spot check agrees with fresh API
 * reads, and the only way to know that is to ask Shopify. The chaos suite proves the
 * logic against a fake; this proves the query, the batching and the id handling against
 * the thing that actually answers.
 *
 *   npx tsx scripts/test-spot-check.ts [sampleSize]
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { auditMirror } from "../app/services/mirror-audit.server";

async function main() {
  const size = Number(process.argv[2] ?? 100) || 100;

  // Name the store or be told which exist. These scripts write real prices to a real
  // storefront, so guessing is the one behaviour not on offer — the same rule the seeder
  // and the perf scripts already follow.
  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error(`No usable session for ${shop.domain}. Reinstall the app.`);

  const total = await prisma.variantIndex.count({
    where: { shopId: shop.id, deletedAt: null },
  });
  console.log(`${shop.domain}: ${total} variants mirrored, checking ${size}.`);

  const started = Date.now();
  const result = await auditMirror(client, shop.id, { size });
  const elapsed = Date.now() - started;

  console.log(
    `checked ${result.checked} in ${elapsed}ms · diverged ${result.diverged} ` +
      `(${(result.rate * 100).toFixed(2)}%) · healed ${result.healed} · ` +
      `tombstoned ${result.tombstoned} · alert ${result.alert}`,
  );

  // Named, not counted. "3 diverged" is a number; "these three variants disagreed, by
  // this much" is something a person can act on.
  for (const divergence of result.divergences.slice(0, 10)) {
    console.log(`  ${divergence.kind}: ${divergence.variantGid}`);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
