#!/usr/bin/env node
/**
 * The data-restore procedure, executed and timed.
 *
 *   npm run drill:restore
 *
 * `docs/runbooks.md` § Data restore states an objective and then says what this script
 * exists to fix:
 *
 *   "Rehearse this, do not assume it. The numbers above are objectives until somebody
 *    has timed them against a real snapshot."
 *
 * Until now nobody had, so all five steps were hypotheses — including `npm run setup`,
 * which has to apply migrations to a snapshot that predates them, and which nothing had
 * ever asked to do.
 *
 * ## What it proves and what it does not
 *
 * **RTO — measured here.** Dump, restore and migrate against real data volumes.
 *
 * **RPO — not measurable here, and deliberately not implied.** Five minutes depends on
 * Railway's backup cadence and point-in-time recovery, which needs the Railway console.
 * The verdict says so rather than staying quiet about it, because a drill that reports
 * PASS on everything it looked at, having not looked at half the objective, is the exact
 * dishonesty the chaos suite exists to catch the engine doing.
 *
 * ## Safety
 *
 * Reads the source database and writes only to a target it creates. The target name
 * carries a fixed prefix and the script refuses to touch anything else, because "drop the
 * database" is the one instruction here that cannot be taken back.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** RTO from the runbook. One hour, in milliseconds. */
export const RTO_BUDGET_MS = 60 * 60_000;

/**
 * Tables whose row counts must match exactly for a restore to count as complete.
 *
 * The runbook orders them by how badly it hurts to lose them, and the first two are the
 * reason this is a product rather than a spreadsheet: baselines are what every campaign
 * computes from, and the ledger is what makes a revert trustworthy. A restore that came
 * back "successful" while silently short on either is the failure worth catching.
 */
export const CRITICAL_TABLES = [
  "baselines",
  "variant_changes",
  "campaigns",
  "campaign_runs",
  "variant_index",
  "price_surface_entries",
] as const;

/**
 * Database objects the app stops working without, which a plain row count cannot see.
 *
 * `pg_trgm` earns its place here: it arrived in #512, a dump carries `CREATE EXTENSION`
 * only if the target cluster has the extension available, and the first time anybody
 * would discover otherwise is mid-restore. The trigram indexes are named for the same
 * reason — a restore that returns every row and none of the indexes is a working app that
 * takes forty times longer to search, which reads as "the restore worked".
 */
export const REQUIRED_OBJECTS = {
  extensions: ["pg_trgm"],
  indexes: [
    "variant_index_title_trgm",
    "variant_index_sku_trgm",
    "variant_index_barcode_trgm",
    "variant_changes_drift_lookup",
  ],
} as const;

export interface RestoreDrill {
  dumpMs: number;
  restoreMs: number;
  migrateMs: number;
  dumpBytes: number;
  /** Row counts before and after, per table. */
  rows: Array<{ table: string; source: number; restored: number }>;
  missingExtensions: string[];
  missingIndexes: string[];
  /** Whether the target database was removed afterwards. */
  cleanedUp: boolean;
}

export const totalMs = (drill: RestoreDrill): number =>
  drill.dumpMs + drill.restoreMs + drill.migrateMs;

/** What the drill proved, or did not. */
export function verdict(drill: RestoreDrill): string[] {
  const lines: string[] = [];
  const elapsed = totalMs(drill);
  const minutes = (ms: number) => (ms / 60_000).toFixed(1);

  lines.push(
    elapsed <= RTO_BUDGET_MS
      ? `PASS  restored in ${minutes(elapsed)} min, inside the 60.0 min RTO`
      : `FAIL  restore took ${minutes(elapsed)} min against a 60.0 min RTO`,
  );

  // A negative count means the table could not be read at all. Equality alone would let
  // a table missing from *both* databases pass as "matching" -- two unreadable counts are
  // equal, and a drill that reports a whole restore because it could not find either copy
  // is worse than one that crashes.
  const unreadable = drill.rows.filter((row) => row.source < 0 || row.restored < 0);
  const short = drill.rows.filter((row) => row.restored !== row.source);
  const wrong = [...new Set([...unreadable, ...short])];

  lines.push(
    drill.rows.length === 0
      ? `FAIL  compared no tables, so nothing about completeness was observed`
      : wrong.length === 0
        ? `PASS  every one of ${drill.rows.length} critical tables came back whole`
        : `FAIL  ${wrong
            .map((row) =>
              row.source < 0 || row.restored < 0
                ? `${row.table} could not be counted`
                : `${row.table} ${row.restored} of ${row.source}`,
            )
            .join(", ")}`,
  );

  lines.push(
    drill.missingExtensions.length === 0 && drill.missingIndexes.length === 0
      ? `PASS  extensions and indexes the app depends on are present`
      : `FAIL  missing ${[...drill.missingExtensions, ...drill.missingIndexes].join(", ")}`,
  );

  lines.push(
    `      dump ${minutes(drill.dumpMs)} min · restore ${minutes(drill.restoreMs)} min · ` +
      `migrate ${minutes(drill.migrateMs)} min · ` +
      `${(drill.dumpBytes / 1024 / 1024).toFixed(0)} MB`,
  );

  // Always reported, because a drill that leaves a database behind is worse than no drill.
  lines.push(
    drill.cleanedUp
      ? `      target database dropped`
      : `WARN  target database left behind — drop it by hand`,
  );

  // Stated on every run rather than only when it matters. Half the runbook's objective is
  // not measured here, and a verdict that mentioned it only in a footnote would let three
  // PASS lines read as "the objective is met".
  lines.push(
    `      RPO NOT MEASURED — the 5 min objective depends on Railway's backup cadence ` +
      `and point-in-time recovery, which this drill cannot reach`,
  );

  return lines;
}

export const passed = (lines: readonly string[]): boolean =>
  !lines.some((line) => line.startsWith("FAIL"));

// ------------------------------------------------------------------ execution

/** Target databases this drill may create, and the only ones it may drop. */
const TARGET_PREFIX = "anchor_restore_drill_";

function psqlEnv(url: URL): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
}

function connection(url: URL): string[] {
  return ["-h", url.hostname, "-p", url.port || "5432", "-U", decodeURIComponent(url.username)];
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function timed<T>(fn: () => T): [T, number] {
  const started = process.hrtime.bigint();
  const value = fn();
  return [value, Number(process.hrtime.bigint() - started) / 1e6];
}

function countRows(url: URL, database: string, table: string): number {
  try {
    const out = run(
      "psql",
      [...connection(url), "-d", database, "-X", "-t", "-A", "-c", `SELECT count(*) FROM "${table}"`],
      psqlEnv(url),
    );
    return Number(out.trim());
  } catch {
    // A table missing from the restore is a count of nothing, which is what the verdict
    // should compare against — not a crash that hides which table it was.
    return -1;
  }
}

function present(url: URL, database: string, query: string): Set<string> {
  const out = run(
    "psql",
    [...connection(url), "-d", database, "-X", "-t", "-A", "-c", query],
    psqlEnv(url),
  );
  return new Set(out.split("\n").map((line) => line.trim()).filter(Boolean));
}

async function main(): Promise<void> {
  // The other scripts here reach the database through `app/db.server`, which is what
  // loads `.env`. This one talks to `pg_dump` directly and never imports it, so it has
  // to do the same itself — as the chaos harness does, for the same reason.
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(".env");
    } catch {
      // No .env is fine as long as the variable is set some other way, as in CI.
    }
  }

  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error("This drill needs a real Postgres. Set DATABASE_URL (or put it in .env).");
  }

  const url = new URL(raw);
  const source = url.pathname.replace(/^\//, "");
  const target = `${TARGET_PREFIX}${process.pid}`;
  const workDir = mkdtempSync(join(tmpdir(), "anchor-restore-"));
  const dumpPath = join(workDir, "source.dump");

  console.log(`Rehearsing docs/runbooks.md § Data restore.`);
  console.log(`  source ${source} → target ${target}\n`);

  // Step 1 of the runbook is "stop the worker first". Not simulated: this reads the
  // source and writes only to a database it creates, so there is nothing for a running
  // worker to half-write. Said out loud because a drill that silently skips a step is
  // rehearsing a procedure nobody will follow.
  console.log("  (runbook step 1, stop the worker, does not apply — this drill writes to a copy)");

  const [, dumpMs] = timed(() =>
    run(
      "pg_dump",
      [...connection(url), "-d", source, "-Fc", "--no-owner", "--no-acl", "-f", dumpPath],
      psqlEnv(url),
    ),
  );
  const dumpBytes = statSync(dumpPath).size;
  console.log(`  dumped ${(dumpBytes / 1024 / 1024).toFixed(0)} MB in ${(dumpMs / 1000).toFixed(1)}s`);

  let cleanedUp = false;
  try {
    run("createdb", [...connection(url), target], psqlEnv(url));

    const [, restoreMs] = timed(() => {
      try {
        run(
          "pg_restore",
          [...connection(url), "-d", target, "--no-owner", "--no-acl", "-j", "4", dumpPath],
          psqlEnv(url),
        );
      } catch (error) {
        // pg_restore exits non-zero on warnings it also recovers from. Whether the
        // restore is *complete* is decided by the row counts below, not by this code.
        console.log(`  pg_restore reported: ${(error as Error).message.split("\n")[0]}`);
      }
      return null;
    });
    console.log(`  restored in ${(restoreMs / 1000).toFixed(1)}s`);

    // Runbook step 3. The step nothing had ever executed: a restored snapshot can predate
    // migrations, and `migrate deploy` has to be a no-op on a current one.
    const targetUrl = new URL(raw);
    targetUrl.pathname = `/${target}`;
    const [, migrateMs] = timed(() =>
      run("npx", ["prisma", "migrate", "deploy"], {
        ...process.env,
        DATABASE_URL: targetUrl.toString(),
      }),
    );
    console.log(`  migrations applied in ${(migrateMs / 1000).toFixed(1)}s`);

    const rows = CRITICAL_TABLES.map((table) => ({
      table,
      source: countRows(url, source, table),
      restored: countRows(url, target, table),
    }));

    const extensions = present(url, target, "SELECT extname FROM pg_extension");
    const indexes = present(url, target, "SELECT indexname FROM pg_indexes WHERE schemaname='public'");

    const drill: RestoreDrill = {
      dumpMs,
      restoreMs,
      migrateMs,
      dumpBytes,
      rows,
      missingExtensions: REQUIRED_OBJECTS.extensions.filter((name) => !extensions.has(name)),
      missingIndexes: REQUIRED_OBJECTS.indexes.filter((name) => !indexes.has(name)),
      cleanedUp: false,
    };

    // Dropped before the verdict is printed, so the verdict can report whether it worked.
    if (target.startsWith(TARGET_PREFIX)) {
      try {
        run("dropdb", [...connection(url), target], psqlEnv(url));
        cleanedUp = true;
      } catch {
        cleanedUp = false;
      }
    }
    drill.cleanedUp = cleanedUp;

    console.log("");
    const lines = verdict(drill);
    for (const line of lines) console.log(`  ${line}`);

    if (!passed(lines)) process.exitCode = 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (!cleanedUp) {
      try {
        run("dropdb", [...connection(url), "--if-exists", target], psqlEnv(url));
      } catch {
        console.error(`  could not drop ${target} — drop it by hand`);
      }
    }
  }
}

// Only when run as a script. Importing this module — which the test beside it does, for
// the verdict logic — must not perform the drill: `main()` at import time races the test
// runner, and the race it usually wins is the one where nothing happens. `drill-mirror`
// already guards itself this way.
if (process.argv[1]?.includes("drill-restore")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
