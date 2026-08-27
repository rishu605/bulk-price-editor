/**
 * Runs every scope probe against the real store and prints what Shopify allowed.
 *
 * Resolves D4. The docs claim `write_products` covers products, variants, price lists
 * and catalogs; the only way to know is to ask, and the answer decides how many
 * permission checkboxes a merchant reads before installing.
 *
 *   npx tsx scripts/scope-probe.ts
 *
 * Nothing is created or changed — see the note in `app/lib/shopify/scope-probe.ts` on
 * why a deliberately-doomed input still answers the question.
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import {
  classifyProbe,
  minimalScopes,
  PROBES,
  scopeGaps,
  type ProbeResult,
} from "../app/lib/shopify/scope-probe";

const MARK: Record<ProbeResult["verdict"], string> = {
  granted: "PASS",
  denied: "DENIED",
  inconclusive: "?",
};

async function main() {
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

  console.log(`Probing ${shop.domain} with the scopes currently granted.\n`);

  const results: Array<{ probe: (typeof PROBES)[number]; result: ProbeResult }> = [];

  for (const probe of PROBES) {
    // The admin client throws on top-level errors, which is right for the app and wrong
    // here — a top-level error is the answer we came for. Caught and re-shaped into the
    // body the classifier expects.
    let body: unknown;
    try {
      body = await client.request(probe.document, probe.variables);
    } catch (error) {
      body = { errors: (error as Error).message };
    }

    const result = classifyProbe(body);
    results.push({ probe, result });

    const detail = result.requires
      ? `needs ${result.requires}`
      : result.detail.slice(0, 60);
    console.log(
      `  ${MARK[result.verdict].padEnd(7)} ${probe.name.padEnd(32)} ${detail}`,
    );
  }

  const denied = results.filter(({ result }) => result.verdict === "denied");
  const unknown = results.filter(({ result }) => result.verdict === "inconclusive");

  console.log("");

  // What Shopify recorded as actually granted, which is not the same string the manifest
  // asks for — Shopify collapses a read scope into its write counterpart. Printing it
  // makes the report self-describing: a PASS only means "passes under *this* grant".
  const session = await prisma.session.findFirst({
    where: { shop: shop.domain, isOnline: false },
    select: { scope: true },
  });
  const granted = (session?.scope ?? "").split(",").filter(Boolean);
  console.log(`Granted:   ${granted.sort().join(",") || "(unknown)"}`);

  // The set the probes justify, assembled from what Shopify actually asked for rather
  // than from what the manifest happens to say today.
  // Scoped to what ships now. A probe marked `neededAt` belongs to a later phase, and
  // folding it in here would mean asking merchants today for access to a feature that
  // does not exist yet — the exact over-asking this task is meant to prevent.
  const shippingNow = results.filter(({ probe }) => !probe.neededAt);
  const needed = new Set(
    shippingNow
      .filter(({ result }) => result.verdict === "granted")
      .map(({ probe }) => probe.expects),
  );
  for (const { result, probe } of shippingNow.filter((r) => r.result.verdict === "denied")) {
    needed.add(result.requires ?? probe.expects);
  }

  const minimum = minimalScopes(needed);
  console.log(`Justified: ${minimum.join(",")}`);

  // The line that earns the task. Every scope here is a permission checkbox nothing in
  // the probe set needed — a cost to install conversion with no capability behind it.
  //
  // It cannot prove the scope is removable on its own: this probe reports what fails
  // under the *current* grant, and a scope that is present is never exercised as absent.
  // Confirming a removal means narrowing the manifest, reinstalling, and running this
  // again. The value is in naming the candidates, which is otherwise guesswork.
  const gaps = scopeGaps(granted, minimum);
  if (gaps.missing.length > 0) {
    console.log(`\nMISSING: ${gaps.missing.join(",")} — the app cannot do what it claims.`);
  }
  if (gaps.overBroad.length > 0) {
    console.log(
      `\nOver-broad: ${gaps.overBroad.join(",")}` +
        `\n  Only the read half was ever exercised. Narrow the manifest, reinstall, rerun.`,
    );
  }
  if (gaps.unneeded.length > 0) {
    console.log(`\nUnneeded: ${gaps.unneeded.join(",")} — no probe touched these.`);
  }

  const broken = denied.filter(({ probe }) => !probe.neededAt);
  if (broken.length > 0) {
    console.log(`\n${broken.length} denied and needed now:`);
    for (const { probe, result } of broken) {
      console.log(`  ${probe.name} — ${probe.purpose}\n    ${result.detail}`);
    }
  }

  // Named as a future cost rather than a failure. The point of probing these early is to
  // learn the price of the phase before committing to it: adding a scope after launch
  // re-prompts every existing install, so "P6.1 costs one more checkbox" is a fact worth
  // having while P6.1 is still a plan.
  const later = denied.filter(({ probe }) => probe.neededAt);
  if (later.length > 0) {
    console.log("\nWill need a wider grant later:");
    for (const { probe, result } of later) {
      console.log(
        `  ${probe.neededAt}: ${probe.name} needs ${result.requires ?? probe.expects} — ${probe.purpose}`,
      );
    }
  }

  // Never silent. An inconclusive probe is a probe that has not run, and reporting the
  // set as settled while one of them was throttled is how a wrong scope list gets
  // published.
  if (unknown.length > 0) {
    console.log(`\n${unknown.length} inconclusive — rerun before trusting the set:`);
    for (const { probe, result } of unknown) {
      console.log(`  ${probe.name} — ${result.detail}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
