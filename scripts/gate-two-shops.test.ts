/**
 * What the two-shop gate script may do, checked over its source (#813).
 *
 * Its verdict and its allowlist are pure and tested in `app/lib/perf/two-shop-gate.test.ts`.
 * What only the source can show is that the script actually goes through them -- and that
 * it stays the thing its header says it is: a merchant pressing buttons on the two
 * development stores, reading the database and never writing to it. It runs against
 * staging or production, so a second writer slipped in here would be a second writer
 * against a real deployment.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../app/lib/testing/source";

const source = sourceOf("scripts/gate-two-shops.ts");

describe("the gate script", () => {
  it("holds every store it picks to the allowlist", () => {
    // `chooseShop` turns what was typed into an installed store; `gateShops` then refuses
    // anything but anchor-perf and DartMode Labs. Both picks go through it, in one call.
    expect(source).toMatch(/gateShops\(\s*chooseShop\(installed, flag\("--load-shop"\) \?\? "anchor-perf"\)\.domain,\s*chooseShop\(installed, flag\("--observed-shop"\) \?\? "dartmode-labs"\)\.domain,\s*\)/);
    expect(source.match(/chooseShop\(/g)).toHaveLength(2);
  });

  it("checks each campaign belongs to its store before pressing anything", () => {
    expect(source).toMatch(/where: \{ id: campaignId, shopId: shop\.id \}/);
    expect(source.indexOf('refuseUnlessReady("load"')).toBeLessThan(source.indexOf("await loadRun("));
    expect(source.indexOf('refuseUnlessReady("probe"')).toBeLessThan(source.indexOf("await loadRun("));
  });

  it("writes prices only through the app's own page actions", () => {
    expect(source).not.toMatch(/adminClientForShop|runCampaign|\.graphql\(|client\.request\(/);
    expect(source).toMatch(/\/app\/campaigns\/\$\{campaignId\}\.data/);
  });

  it("only reads the database", () => {
    expect(source).not.toMatch(/prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(source).not.toMatch(/\$executeRaw|\$queryRawUnsafe|\$transaction/);
  });

  it("does not start a gate when imported", () => {
    expect(source).toMatch(/if \(process\.argv\[1\]\?\.includes\("gate-two-shops"\)\)/);
  });

  it("judges with the tested evaluator, and fails the process on a miss", () => {
    expect(source).toMatch(/report\(evaluateGate\(record\)\)/);
    expect(source).toMatch(/process\.exitCode = 1/);
  });
});
