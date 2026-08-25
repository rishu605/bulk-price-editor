/**
 * Scenario scaffolding, so each scenario file is the break and the assertion and
 * nothing else.
 *
 * The engine under test is the real one: `runCampaign` against a real Postgres,
 * through the real planner, executors, ledger and state machine. Only the store is a
 * stand-in, and it is modelled rather than stubbed and reached over real HTTP.
 * Anything less and the suite would be proving the harness works.
 */

import { expect } from "vitest";

import prisma from "../../app/db.server";
import { runCampaign, type RunOptions } from "../../app/services/campaigns/run.server";
import type { RunOutcome } from "../../app/services/campaigns/types";
import type { FakeShopify } from "./fake-shopify";
import type { FaultRule } from "./faults";
import { chaosAdminClient } from "./http-client";
import { writeReport } from "./report";
import { destroyFixture, seedFixture, type CatalogSpec, type Fixture } from "./seed";
import { FakeShopifyServer } from "./shopify-server";
import { judge, type Verdict } from "./verdict";

/** Overridable so a failing run replays exactly: `CHAOS_SEED=1234 npm run test:chaos`. */
export const RUN_SEED = Number(process.env.CHAOS_SEED ?? 20260825);

export interface ChaosContext {
  fixture: Fixture;
  server: FakeShopifyServer;
  fake: FakeShopify;
  seed: number;

  /** Arms fault rules, replacing any already armed. */
  arm(rules: FaultRule[]): void;
  /** Stops all faults, so a scenario can prove recovery after the break. */
  heal(): void;

  /** Applies the campaign in-process, through the real run path. */
  apply(options?: RunOptions): Promise<RunOutcome>;
  /** Reverts it, likewise -- `resolve(without C)`, not a restore. */
  revert(options?: RunOptions): Promise<RunOutcome>;

  /** What the store says right now, per variant. */
  livePrices(): Map<string, string | undefined>;

  /**
   * The suite's one assertion: verified-clean or visibly partial, never silently
   * wrong. Writes a diagnosable artefact before failing.
   */
  expectHonest(runId: string): Promise<Verdict>;

  /** The most recent run for this campaign, for scenarios that kill the runner. */
  latestRunId(kind?: "APPLY" | "REVERT"): Promise<string>;
}

export interface ChaosSpec {
  catalog: CatalogSpec;
  percent?: number;
  /** Polls a bulk operation stays RUNNING. Higher exercises the fallback harder. */
  pollsBeforeComplete?: number;
}

/**
 * Runs one scenario against its own shop, then tears it down.
 *
 * On failure the fixture is left in the database deliberately. The artefact points at
 * it by id, and being able to open the ledger afterwards is the difference between
 * diagnosing a chaos failure and re-running it until it goes away.
 */
export async function withChaos(
  scenario: string,
  spec: ChaosSpec,
  body: (context: ChaosContext) => Promise<void>,
): Promise<void> {
  const seed = RUN_SEED;
  const server = new FakeShopifyServer({ pollsBeforeComplete: spec.pollsBeforeComplete ?? 1 });
  await server.start();

  const fixture = await seedFixture({
    scenario,
    seed,
    fake: server.fake,
    catalog: spec.catalog,
    percent: spec.percent,
  });

  const client = chaosAdminClient(server.endpoint());
  let passed = false;

  const context: ChaosContext = {
    fixture,
    server,
    fake: server.fake,
    seed,

    arm: (rules) => server.faults.arm(rules),
    heal: () => server.faults.heal(),

    // Deliberately no lifecycle transition first. `runCampaign` owns entering the
    // running state, and a harness that helpfully moved the campaign to APPLYING
    // beforehand was testing a path the campaign page does not take -- which is
    // exactly how applying a draft came to write and verify four prices and then
    // report "nothing has been written to your storefront".
    apply: async (options = {}) =>
      runCampaign(fixture.shopId, fixture.campaignId, client, {
        // Full read-back. Sampling would let a scenario pass because the one bad row
        // happened not to be sampled -- the opposite of what this suite is for.
        verifySampleRate: 1,
        ...options,
      }),

    revert: async (options = {}) =>
      runCampaign(fixture.shopId, fixture.campaignId, client, {
        revert: true,
        verifySampleRate: 1,
        ...options,
      }),

    livePrices: () =>
      new Map(fixture.variantGids.map((gid) => [gid, server.fake.priceOf(gid)])),

    latestRunId: async (kind = "APPLY") => {
      const run = await prisma.campaignRun.findFirstOrThrow({
        where: { campaignId: fixture.campaignId, kind },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      return run.id;
    },

    expectHonest: async (runId) => {
      const verdict = await judge(fixture, server.fake, runId);
      if (!verdict.ok) {
        const path = await writeReport(scenario, seed, fixture, server.fake, runId, verdict);
        expect.fail(
          `${scenario}: the engine ended in a state it cannot justify.\n` +
            verdict.violations.map((v) => `  - ${v}`).join("\n") +
            `\n\nArtefact: ${path}\nReplay:   CHAOS_SEED=${seed} npm run test:chaos -- ${scenario}`,
        );
      }
      return verdict;
    },
  };

  try {
    await body(context);
    passed = true;
  } finally {
    await server.stop();
    if (passed) await destroyFixture(fixture.domain);
  }
}

/** The ledger for a run, for scenarios that assert on specific row states. */
export function ledgerOf(runId: string) {
  return prisma.variantChange.findMany({ where: { runId }, orderBy: { variantGid: "asc" } });
}
