#!/usr/bin/env node
/**
 * Runs the real targeting and planning code paths and EXPLAINs every statement they emit.
 *
 *   npm run measure:queries -- --shop anchor-perf
 *
 * `measure:admin` answers "how long does this page take". This answers the question
 * underneath it: *why*, and whether the answer survives a catalogue ten times bigger. A
 * query that seq-scans 100K rows in 40ms looks healthy on a laptop and is still a table
 * scan that grows with the merchant.
 *
 * The statements are captured from Prisma's query event rather than written out here, so
 * what gets EXPLAINed is by construction what the app sends. That distinction is the
 * whole point of the script: hand-copying a query into an EXPLAIN measures the query you
 * believe the ORM builds. `vendor` is the case in point -- the filter engine asks for
 * `equals` with `mode: "insensitive"`, Prisma emits `ILIKE`, and a `lower(vendor)` index
 * cannot serve `ILIKE`. Nothing about the Prisma call says so, and the index that was
 * built for it recorded zero scans for as long as it existed.
 *
 * Read-only: every path here is a count or a select, so unlike the other scripts in this
 * directory it writes nothing to the store.
 */

import { PrismaClient } from "@prisma/client";

import { chooseShop, shopArg } from "../app/lib/seed/target-shop";

/** A statement Prisma sent, with the parameters it bound. */
export interface Captured {
  sql: string;
  params: unknown[];
}

/** What EXPLAIN said about one statement. */
export interface Plan {
  sql: string;
  scannedRelations: string[];
  rowsRemovedByFilter: number;
  executionMs: number;
  sharedBlocks: number;
}

/**
 * Transaction and housekeeping statements, which EXPLAIN rejects.
 *
 * Matched on the leading keyword rather than the whole statement: Prisma emits
 * `DEALLOCATE ALL` and bare `BEGIN`, and a future version emitting `SET` or `SAVEPOINT`
 * should be skipped too rather than crashing the run.
 */
export const NOT_EXPLAINABLE = /^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE|SET|SAVEPOINT|RELEASE)\b/i;

/** The plan node types that mean "read every row of this table". */
const FULL_SCAN = /^(Seq Scan|Parallel Seq Scan)$/;

/**
 * Parses the parameter array Prisma logs.
 *
 * It arrives as a JSON string, and every value in it is already in a form Postgres will
 * take back as a bind parameter -- including arrays, which is what `tags @> $2` sends.
 */
export function parseParams(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Every node in an EXPLAIN plan tree, parents before children. */
export function walk(node: Record<string, unknown>): Record<string, unknown>[] {
  const children = (node["Plans"] as Record<string, unknown>[] | undefined) ?? [];
  return [node, ...children.flatMap(walk)];
}

export function summarise(sql: string, root: Record<string, unknown>, executionMs: number): Plan {
  const nodes = walk(root);

  return {
    sql,
    scannedRelations: [
      ...new Set(
        nodes
          .filter((n) => FULL_SCAN.test(String(n["Node Type"])))
          .map((n) => String(n["Relation Name"] ?? "?")),
      ),
    ],
    // Multiplied by loops: a scan inside a nested loop reports its per-iteration figure,
    // and the per-iteration figure of a scan run 5,000 times is the misleading one.
    rowsRemovedByFilter: nodes.reduce(
      (total, n) =>
        total + Number(n["Rows Removed by Filter"] ?? 0) * Number(n["Actual Loops"] ?? 1),
      0,
    ),
    executionMs,
    sharedBlocks: nodes.reduce(
      (total, n) =>
        total + Number(n["Shared Hit Blocks"] ?? 0) + Number(n["Shared Read Blocks"] ?? 0),
      0,
    ),
  };
}

/**
 * EXPLAINs one captured statement.
 *
 * `ANALYZE` means the statement genuinely runs, which is why this script is restricted to
 * reads. Returns null for anything Postgres will not plan -- a statement that cannot be
 * explained is not a finding, and failing the whole run over one is how a measurement
 * tool stops being used.
 */
async function explain(client: PrismaClient, captured: Captured): Promise<Plan | null> {
  if (NOT_EXPLAINABLE.test(captured.sql)) return null;

  try {
    const rows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.sql}`,
      ...captured.params,
    );

    // Postgres returns one row holding the whole plan; the column name differs by
    // version, so take whatever the single column holds.
    const payload = Object.values(rows[0] ?? {})[0];
    const plan = (Array.isArray(payload) ? payload[0] : payload) as
      | { Plan: Record<string, unknown>; "Execution Time": number }
      | undefined;
    if (!plan?.Plan) return null;

    return summarise(captured.sql, plan.Plan, Number(plan["Execution Time"] ?? 0));
  } catch {
    // Statements Prisma parameterises in ways EXPLAIN will not accept back. Silent
    // rather than noisy: that is a property of the driver, not of our schema.
    return null;
  }
}

/** One named code path, its wall clock, and the plans behind it. */
interface PathResult {
  label: string;
  wallMs: number;
  statements: number;
  plans: Plan[];
}

function report(result: PathResult): void {
  const scans = result.plans.filter((p) => p.scannedRelations.length > 0);

  console.log(
    `\n  ${result.label}\n` +
      `    ${result.wallMs.toFixed(0)}ms wall · ${result.statements} statements · ` +
      `${scans.length} reading a whole table`,
  );

  for (const plan of [...result.plans].sort((a, b) => b.executionMs - a.executionMs).slice(0, 3)) {
    const how = plan.scannedRelations.length
      ? `SEQ SCAN ${plan.scannedRelations.join(", ")}`
      : "indexed";
    console.log(
      `      ${plan.executionMs.toFixed(1).padStart(7)}ms  ` +
        `${String(plan.sharedBlocks).padStart(6)} blocks  ` +
        `${String(plan.rowsRemovedByFilter).padStart(7)} discarded  ${how}`,
    );
    console.log(`               ${plan.sql.replace(/\s+/g, " ").slice(0, 128)}`);
  }
}

async function main(): Promise<void> {
  // The observing client is installed as the global *before* anything that imports
  // `db.server` is loaded. `db.server` binds its export at module evaluation, so a swap
  // afterwards would leave every service holding the client it first saw -- the paths
  // would run, nothing would be captured, and the script would report a clean bill of
  // health for a catalogue it never looked at.
  const observed = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  globalThis.prismaGlobal = observed;

  const captured: Captured[] = [];
  let capturing = false;
  observed.$on("query", (event) => {
    if (capturing) captured.push({ sql: event.query, params: parseParams(event.params) });
  });

  const { default: prisma } = await import("../app/db.server");
  if (prisma !== observed) {
    throw new Error(
      "db.server did not take the observing client, so no statement would be captured.",
    );
  }

  const { loadCandidates } = await import("../app/services/campaigns/candidates.server");
  const segments = await import("../app/services/segments.server");
  const { facets, previewMatches, resolveVariantGids } = segments;
  type FilterAst = import("../app/services/segments.server").FilterAst;

  // A second, plain client for EXPLAIN itself. Running it on `observed` would capture
  // the EXPLAIN statements too and measure the measurement.
  const explainer = new PrismaClient();

  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });
  const total = await prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } });

  console.log(`${shop.domain}: ${total} variants.`);
  console.log("\n  Each path is the real service function; every statement it emits is");
  console.log("  captured from Prisma and run through EXPLAIN (ANALYZE, BUFFERS).");

  const measure = async (label: string, fn: () => Promise<unknown>): Promise<PathResult> => {
    captured.length = 0;
    capturing = true;
    const started = process.hrtime.bigint();
    await fn();
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    capturing = false;

    const plans: Plan[] = [];
    for (const statement of captured) {
      const plan = await explain(explainer, statement);
      if (plan) plans.push(plan);
    }
    return { label, wallMs, statements: captured.length, plans };
  };

  const ast = (...conditions: FilterAst["groups"][number]["conditions"]): FilterAst => ({
    groups: conditions.length ? [{ conditions }] : [],
  });

  const everything = ast();
  const byTag = ast({ field: "tag", value: "sale" });

  const paths: Array<[string, () => Promise<unknown>]> = [
    // The filter engine, one condition at a time. A merchant combines them, but a
    // combination is only as fast as its worst leg and the legs are what we can fix.
    ["scope: whole catalogue", () => previewMatches(shop.id, everything)],
    ["scope: tag", () => previewMatches(shop.id, byTag)],
    [
      "scope: collection",
      () => previewMatches(shop.id, ast({ field: "collection", value: "anchor-perf-1" })),
    ],
    [
      "scope: vendor",
      () => previewMatches(shop.id, ast({ field: "vendor", value: "Anchor Supply" })),
    ],
    [
      "scope: product type",
      () => previewMatches(shop.id, ast({ field: "productType", value: "Boots" })),
    ],
    ["scope: title contains", () => previewMatches(shop.id, ast({ field: "title", value: "Alpine" }))],
    ["scope: sku contains", () => previewMatches(shop.id, ast({ field: "sku", value: "AB-1" }))],
    ["scope: price floor", () => previewMatches(shop.id, ast({ field: "priceMin", value: 2000 }))],

    // The picker's option lists, which three route loaders await before first paint.
    ["facets: the scope picker's options", () => facets(shop.id)],

    // Enrolment and planning, the two paths that touch every variant in scope.
    ["enrol: every gid in scope", () => resolveVariantGids(shop.id, byTag)],
    ["plan: candidates for a tag", () => loadCandidates(shop.id, byTag)],
    ["plan: candidates for the whole catalogue", () => loadCandidates(shop.id, everything)],
  ];

  // Warm the pool and the page cache once, so the first path measured is not also
  // measuring the connection handshake.
  await prisma.variantIndex.count({ where: { shopId: shop.id } });

  const results: PathResult[] = [];
  for (const [label, fn] of paths) results.push(await measure(label, fn));

  for (const result of results) report(result);

  const scanning = results.flatMap((r) =>
    r.plans.filter((p) => p.scannedRelations.length > 0).map((plan) => ({ path: r.label, plan })),
  );
  const planned = results.reduce((n, r) => n + r.plans.length, 0);

  console.log(`\n  ${scanning.length} of ${planned} statements read a whole table:`);
  for (const { path, plan } of scanning.sort((a, b) => b.plan.executionMs - a.plan.executionMs)) {
    console.log(
      `    ${plan.executionMs.toFixed(1).padStart(7)}ms  ` +
        `${plan.scannedRelations.join(", ").padEnd(22)} ${path}`,
    );
  }

  await Promise.all([observed.$disconnect(), explainer.$disconnect()]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
