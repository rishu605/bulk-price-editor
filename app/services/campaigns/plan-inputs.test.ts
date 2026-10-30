/**
 * Every table a plan reads is one whose writes make a stored plan stale (#812).
 *
 * A stored plan is current while no write logged for its shop is invisible to the snapshot it
 * was planned from, and the log is written by triggers -- one set per table, listed in the
 * migration that adds them. A table the planner starts reading without a trigger is a write
 * the log never hears of: a stored plan that is stale and reads as current, which is the one
 * failure stored plans must not have. Nothing would say so; the page would just show last
 * week's numbers as the answer.
 *
 * So this reads the planner's modules for every table they read, through Prisma or in SQL,
 * and the migrations for every table with a trigger, and asks for the first to be inside the
 * second -- or excused here, with why no plan's answer depends on it.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { rawSource, sourceOf } from "../../lib/testing/source";

/** The modules `previewCampaign`, `rollbackReport` and `keepersOf` plan through. */
const PLANNER = [
  "app/services/campaigns/preview.server.ts",
  "app/services/campaigns/rollback-report.server.ts",
  "app/services/campaigns/keepers.server.ts",
  "app/services/campaigns/model.server.ts",
  "app/services/campaigns/candidates.server.ts",
  "app/services/campaigns/market-plan.server.ts",
  "app/services/campaigns/market-surfaces.server.ts",
  "app/services/campaigns/handover.server.ts",
  "app/services/campaigns/blocked.server.ts",
  "app/services/reconciliation.server.ts",
  "app/services/settings.server.ts",
  "app/services/segments.server.ts",
];

/** Tables these modules read that no plan's answer depends on, and why. */
const NOT_A_PLAN_INPUT: Record<string, string> = {
  topology_notices:
    "read by the run's market writer for the name of a market that no longer exists, to say it was skipped; " +
    "the preview names a market from the price list itself",
};

/** Prisma's model names to their tables, from the schema's `@@map`s. */
function tablesByModel(): Map<string, string> {
  const schema = rawSource("prisma/schema.prisma");
  const tables = new Map<string, string>();
  // To the closing brace at the start of a line: a model's defaults hold braces of their own.
  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const mapped = /@@map\("([^"]+)"\)/.exec(block[2]);
    const model = block[1];
    tables.set(model.charAt(0).toLowerCase() + model.slice(1), mapped ? mapped[1] : model);
  }
  return tables;
}

/** Every table the planner's modules read. */
function tablesRead(): Set<string> {
  const byModel = tablesByModel();
  const read = new Set<string>();
  for (const file of PLANNER) {
    const source = sourceOf(file);
    for (const [, model] of source.matchAll(
      /\b(?:prisma|tx)\.(\w+)\.(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\b/g,
    )) {
      const table = byModel.get(model);
      expect(table, `${file} reads ${model}, which the schema does not have`).toBeDefined();
      read.add(table!);
    }
    for (const [, table] of source.matchAll(/\b(?:FROM|JOIN)\s+"(\w+)"/g)) read.add(table);
  }
  return read;
}

/** Every table a migration puts a plan-input trigger on. */
function tablesLogged(): Set<string> {
  const dir = join(process.cwd(), "prisma", "migrations");
  const sql = readdirSync(dir)
    .filter((name) => !name.endsWith(".toml"))
    .map((name) => rawSource("prisma", "migrations", name, "migration.sql"))
    .join("\n");
  const logged = new Set<string>();
  for (const [, table] of sql.matchAll(/_plan_inputs_\w+"? AFTER \w+ ON "(\w+)"/g)) logged.add(table);
  // The loop that creates the same three for most of them.
  const loop = /FOREACH t IN ARRAY ARRAY\[([^\]]*)\]/.exec(sql);
  for (const [, table] of (loop?.[1] ?? "").matchAll(/'(\w+)'/g)) logged.add(table);
  return logged;
}

describe("a stored plan hears of every write its answer depends on", () => {
  it("finds the planner's tables and the triggers, so this cannot pass by reading nothing", () => {
    expect(tablesRead().size).toBeGreaterThan(8);
    expect([...tablesLogged()]).toEqual(expect.arrayContaining(["variant_index", "baselines", "campaigns", "shops"]));
  });

  it("logs every table the planner reads", () => {
    const logged = tablesLogged();
    const unlogged = [...tablesRead()].filter((table) => !logged.has(table) && !(table in NOT_A_PLAN_INPUT));
    expect(
      unlogged,
      "the planner reads these and no trigger logs their writes, so a stored plan would read as current after " +
        "one -- add their triggers in a migration, or excuse them in NOT_A_PLAN_INPUT with why no plan depends on them",
    ).toEqual([]);
  });

  it("keeps the excuses honest by requiring each to be read and not logged", () => {
    const read = tablesRead();
    const logged = tablesLogged();
    expect(Object.keys(NOT_A_PLAN_INPUT).filter((table) => !read.has(table) || logged.has(table))).toEqual([]);
  });
});
