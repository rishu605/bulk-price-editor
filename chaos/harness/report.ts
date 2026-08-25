/**
 * The failure artefact.
 *
 * A red chaos run is worth nothing if the only output is "expected true to be false".
 * These runs are non-deterministic in their timing by construction, so whoever picks
 * the failure up may not be able to watch it happen -- they get this file instead:
 * the seed that replays it, the run id, every row's state and reason, and what the
 * store actually said.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import prisma from "../../app/db.server";
import type { FakeShopify } from "./fake-shopify";
import type { Fixture } from "./seed";
import type { Verdict } from "./verdict";

const ARTEFACT_DIR = join(process.cwd(), "chaos", "artefacts");

export async function writeReport(
  scenario: string,
  seed: number,
  fixture: Fixture,
  fake: FakeShopify,
  runId: string,
  verdict: Verdict,
): Promise<string> {
  const rows = await prisma.variantChange.findMany({
    where: { runId },
    orderBy: { variantGid: "asc" },
  });
  const run = await prisma.campaignRun.findUnique({ where: { id: runId } });
  const campaign = await prisma.campaign.findUnique({
    where: { id: fixture.campaignId },
    select: { status: true },
  });

  const lines = [
    `# chaos failure: ${scenario}`,
    "",
    `Replay with:  CHAOS_SEED=${seed} npm run test:chaos -- ${scenario}`,
    "",
    `- shop      ${fixture.domain} (${fixture.shopId})`,
    `- campaign  ${fixture.campaignId} — ${campaign?.status ?? "(gone)"}`,
    `- run       ${runId} — ${run?.status ?? "(gone)"}, finished ${run?.finishedAt?.toISOString() ?? "never"}`,
    `- verdict   ${verdict.outcome}, ${Object.entries(verdict.counts).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    "",
    "## Violations",
    ...verdict.violations.map((violation) => `- ${violation}`),
    "",
    "## Ledger",
    "",
    "| variant | status | intended | live | attempt | reason |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => {
      const live = fake.priceOf(row.variantGid) ?? "(deleted)";
      return `| ${row.variantGid} | ${row.status} | ${row.intendedPrice ?? ""} | ${live} | ${row.attempt} | ${(row.failureReason ?? "").replace(/\|/g, "/")} |`;
    }),
    "",
    `## Writes the store accepted (${fake.writeLog.length})`,
    "",
    ...fake.writeLog.map((write, i) => `${i + 1}. ${write.variantGid} -> ${write.price}`),
    "",
  ];

  mkdirSync(ARTEFACT_DIR, { recursive: true });
  const path = join(ARTEFACT_DIR, `${scenario}.md`);
  writeFileSync(path, lines.join("\n"));
  return path;
}
