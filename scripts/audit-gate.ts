/**
 * The dependency audit gate: CI's verdict on `npm audit`, with one narrow way through.
 *
 * Every high or critical advisory fails the build, judged at the root advisory (its GHSA
 * id), not at the package that happens to carry it. The one way through is an entry in
 * `.github/audit-allowlist.json`, and an entry only counts while all of these hold:
 *
 * - **It has not expired.** Each entry has an `until` date, after which it blocks again,
 *   so an allowance is a dated promise to come back, not a permanent hole.
 * - **The advisory doesn't reach the app's runtime.** The runtime report
 *   (`npm audit --omit=dev`) is judged with no allow-list at all. An advisory that a
 *   deployed process can load always fails, whatever the list says.
 * - **It names one advisory.** Allowing a GHSA id lets exactly that advisory through; a
 *   second advisory on the same package, or anywhere in the same chain, still fails.
 *
 * Why this exists (#915): a dev-only codegen advisory whose only fix needs a newer Node
 * than CI and the image run held the gate red on every PR for a month. A gate that is
 * always red gets merged over, and the step after it (`npm test`) never ran on `main`
 * in that time. See D35.
 *
 * Usage: `npx tsx scripts/audit-gate.ts audit.json audit-runtime.json`
 */

import { readFileSync } from "node:fs";

export const ALLOWLIST_PATH = ".github/audit-allowlist.json";

/** One advisory as `npm audit --json` reports it inside a vulnerability's `via`. */
interface ReportedAdvisory {
  url?: string;
  title?: string;
  name?: string;
  severity?: string;
}

/** The parts of an `npm audit --json` report the gate reads. */
export interface AuditReport {
  metadata?: { vulnerabilities?: Record<string, number> };
  vulnerabilities?: Record<string, { via: Array<string | ReportedAdvisory> }>;
}

export interface AllowEntry {
  /** The root advisory, e.g. `GHSA-7mx3-vvmw-hjmv`. */
  id: string;
  /** The package it is reported against, so a reader can find it in `npm ls`. */
  package: string;
  /** ISO date (UTC). On and after the day after it, the advisory blocks again. */
  until: string;
  /** Why it is safe to merge over, and what would remove it. */
  reason: string;
}

export interface Advisory {
  id: string;
  package: string;
  severity: string;
  title: string;
}

export interface Verdict {
  ok: boolean;
  /** Advisories reaching the runtime. Never allowable. */
  runtime: Advisory[];
  /** Dev-only advisories with no live allow-list entry. */
  blocked: Advisory[];
  /** Dev-only advisories let through, with the entry that let them. */
  allowed: Array<Advisory & { until: string }>;
  /** Entries past their date whose advisory is still reported. */
  expired: AllowEntry[];
  /** Entries whose advisory is no longer reported, so the entry can go. */
  unused: AllowEntry[];
}

const BLOCKING = new Set(["high", "critical"]);

/** Whether the file is a report at all, rather than the registry's error body. */
export function isReport(report: unknown): report is AuditReport {
  return (
    typeof report === "object" &&
    report !== null &&
    typeof (report as AuditReport).metadata?.vulnerabilities === "object"
  );
}

/** The high and critical root advisories in a report, one per GHSA id. */
export function blockingAdvisories(report: AuditReport): Advisory[] {
  const byId = new Map<string, Advisory>();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      // A string `via` is a package that is vulnerable only through another one. The
      // root advisory is reported on that other package, so it is counted there.
      if (typeof via === "string") continue;
      if (!via.severity || !BLOCKING.has(via.severity)) continue;
      const id = via.url?.split("/").pop() ?? `${via.name}: ${via.title}`;
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          package: via.name ?? "unknown",
          severity: via.severity,
          title: via.title ?? "",
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function judge(
  full: AuditReport,
  runtimeReport: AuditReport,
  allowlist: AllowEntry[],
  today: string,
): Verdict {
  const runtime = blockingAdvisories(runtimeReport);
  const runtimeIds = new Set(runtime.map((advisory) => advisory.id));
  const live = new Map(
    allowlist.filter((entry) => entry.until >= today).map((entry) => [entry.id, entry]),
  );

  const blocked: Advisory[] = [];
  const allowed: Verdict["allowed"] = [];
  const reported = blockingAdvisories(full);
  for (const advisory of reported) {
    // Judged in the runtime list instead, where nothing is allowable.
    if (runtimeIds.has(advisory.id)) continue;
    const entry = live.get(advisory.id);
    if (entry) allowed.push({ ...advisory, until: entry.until });
    else blocked.push(advisory);
  }

  const reportedIds = new Set(reported.map((advisory) => advisory.id));
  const expired = allowlist.filter((entry) => entry.until < today && reportedIds.has(entry.id));
  const unused = allowlist.filter((entry) => !reportedIds.has(entry.id));

  return {
    ok: runtime.length === 0 && blocked.length === 0,
    runtime,
    blocked,
    allowed,
    expired,
    unused,
  };
}

/** Throws on a malformed entry, so a typo can't quietly allow everything or nothing. */
export function parseAllowlist(text: string): AllowEntry[] {
  const parsed = JSON.parse(text) as { advisories?: unknown };
  if (!Array.isArray(parsed.advisories)) {
    throw new Error(`${ALLOWLIST_PATH}: expected an "advisories" array`);
  }
  return parsed.advisories.map((raw, index) => {
    const entry = raw as Partial<AllowEntry>;
    const where = `${ALLOWLIST_PATH}: advisories[${index}]`;
    if (!entry.id || !/^GHSA(-[0-9a-z]{4}){3}$/.test(entry.id)) {
      throw new Error(`${where}: "id" must be one GHSA id, e.g. GHSA-7mx3-vvmw-hjmv`);
    }
    if (!entry.until || !/^\d{4}-\d{2}-\d{2}$/.test(entry.until)) {
      throw new Error(`${where} (${entry.id}): "until" must be a date, YYYY-MM-DD`);
    }
    if (!entry.package || !entry.reason) {
      throw new Error(`${where} (${entry.id}): "package" and "reason" are required`);
    }
    return entry as AllowEntry;
  });
}

const line = (advisory: Advisory) =>
  `${advisory.id} ${advisory.severity} in ${advisory.package}: ${advisory.title}`;

function main(fullPath: string, runtimePath: string): number {
  const full: unknown = JSON.parse(readFileSync(fullPath, "utf8"));
  const runtimeReport: unknown = JSON.parse(readFileSync(runtimePath, "utf8"));
  if (!isReport(full) || !isReport(runtimeReport)) {
    console.log("::error::npm audit returned an error body, not a report.");
    return 1;
  }

  const allowlist = parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const verdict = judge(full, runtimeReport, allowlist, today);

  for (const advisory of verdict.runtime) {
    console.log(`::error::Reaches the app's runtime, so no allow-list entry covers it: ${line(advisory)}`);
  }
  for (const entry of verdict.expired) {
    console.log(`::error::Allow-list entry for ${entry.id} expired on ${entry.until}. Fix it, or renew it in ${ALLOWLIST_PATH} with a reason.`);
  }
  for (const advisory of verdict.blocked) {
    if (verdict.expired.some((entry) => entry.id === advisory.id)) continue;
    console.log(`::error::${line(advisory)}`);
  }
  for (const advisory of verdict.allowed) {
    console.log(`::warning::Allowed until ${advisory.until} (dev only): ${line(advisory)}`);
  }
  for (const entry of verdict.unused) {
    console.log(`::notice::${entry.id} is no longer reported; remove its entry from ${ALLOWLIST_PATH}.`);
  }

  if (verdict.ok) {
    console.log(`No blocking advisories (${verdict.allowed.length} allowed, dev only).`);
    return 0;
  }
  return 1;
}

if (process.argv[1]?.endsWith("audit-gate.ts")) {
  const [fullPath, runtimePath] = process.argv.slice(2);
  if (!fullPath || !runtimePath) {
    console.error("Usage: tsx scripts/audit-gate.ts <audit.json> <audit-runtime.json>");
    process.exit(2);
  }
  process.exit(main(fullPath, runtimePath));
}
