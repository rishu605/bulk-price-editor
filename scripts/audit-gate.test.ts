/**
 * What the audit gate lets through, and what it never does.
 *
 * The gate's value is in what it refuses, so most of these are ways an allow-list could
 * become a hole: an entry past its date, an advisory that also reaches the runtime, a
 * second advisory on an allowed package. The committed allow-list is parsed too, so a
 * malformed entry fails here rather than letting everything (or nothing) through in CI.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALLOWLIST_PATH,
  blockingAdvisories,
  isReport,
  judge,
  parseAllowlist,
  type AllowEntry,
  type AuditReport,
} from "./audit-gate";

const advisory = (id: string, name: string, severity = "high") => ({
  url: `https://github.com/advisories/${id}`,
  title: `${name} is vulnerable`,
  name,
  severity,
});

/** A report as `npm audit --json` shapes it, from root advisories and the packages that only carry them. */
const report = (
  roots: Array<ReturnType<typeof advisory>>,
  carriers: Record<string, string[]> = {},
): AuditReport => {
  const vulnerabilities: NonNullable<AuditReport["vulnerabilities"]> = {};
  for (const root of roots) {
    vulnerabilities[root.name] ??= { via: [] };
    vulnerabilities[root.name].via.push(root);
  }
  for (const [name, via] of Object.entries(carriers)) vulnerabilities[name] = { via };
  return { metadata: { vulnerabilities: { high: roots.length } }, vulnerabilities };
};

const CODEGEN = advisory("GHSA-7mx3-vvmw-hjmv", "@graphql-tools/utils");
const EXPRESS = advisory("GHSA-27r3-jxmh-p828", "body-parser");

const entry = (id: string, until = "2027-01-31"): AllowEntry => ({
  id,
  package: "@graphql-tools/utils",
  until,
  reason: "dev only",
});

const TODAY = "2026-11-24";
const clean = report([]);

describe("blockingAdvisories", () => {
  it("counts a root advisory once, however many packages carry it", () => {
    const found = blockingAdvisories(
      report([CODEGEN], { "@graphql-codegen/cli": ["@graphql-tools/utils"] }),
    );
    expect(found.map((a) => a.id)).toEqual(["GHSA-7mx3-vvmw-hjmv"]);
  });

  it("ignores moderate and low advisories", () => {
    expect(blockingAdvisories(report([advisory("GHSA-g3hv-75wg-m249", "minimatch", "moderate")]))).toEqual([]);
  });

  it("counts critical as blocking", () => {
    expect(blockingAdvisories(report([advisory("GHSA-aaaa-bbbb-cccc", "x", "critical")]))).toHaveLength(1);
  });
});

describe("judge", () => {
  it("passes a clean report", () => {
    expect(judge(clean, clean, [], TODAY).ok).toBe(true);
  });

  it("fails a dev-only advisory with no entry", () => {
    const verdict = judge(report([CODEGEN]), clean, [], TODAY);
    expect(verdict.ok).toBe(false);
    expect(verdict.blocked.map((a) => a.id)).toEqual([CODEGEN.url.split("/").pop()]);
  });

  it("lets a dev-only advisory through while its entry is live, and says so", () => {
    const verdict = judge(report([CODEGEN]), clean, [entry("GHSA-7mx3-vvmw-hjmv")], TODAY);
    expect(verdict.ok).toBe(true);
    expect(verdict.allowed).toEqual([expect.objectContaining({ id: "GHSA-7mx3-vvmw-hjmv", until: "2027-01-31" })]);
  });

  it("still lets it through on its last day", () => {
    expect(judge(report([CODEGEN]), clean, [entry("GHSA-7mx3-vvmw-hjmv", TODAY)], TODAY).ok).toBe(true);
  });

  it("blocks again the day after an entry's date, and names the expired entry", () => {
    const verdict = judge(report([CODEGEN]), clean, [entry("GHSA-7mx3-vvmw-hjmv", "2026-11-23")], TODAY);
    expect(verdict.ok).toBe(false);
    expect(verdict.expired.map((e) => e.id)).toEqual(["GHSA-7mx3-vvmw-hjmv"]);
  });

  it("never allows an advisory that reaches the runtime, whatever the list says", () => {
    const verdict = judge(report([EXPRESS]), report([EXPRESS]), [entry("GHSA-27r3-jxmh-p828")], TODAY);
    expect(verdict.ok).toBe(false);
    expect(verdict.runtime.map((a) => a.id)).toEqual(["GHSA-27r3-jxmh-p828"]);
    expect(verdict.allowed).toEqual([]);
  });

  it("allows only the advisory named, not another one on the same package", () => {
    const second = advisory("GHSA-c4qx-w738-7hr3", "@graphql-tools/utils");
    const verdict = judge(report([CODEGEN, second]), clean, [entry("GHSA-7mx3-vvmw-hjmv")], TODAY);
    expect(verdict.ok).toBe(false);
    expect(verdict.blocked.map((a) => a.id)).toEqual(["GHSA-c4qx-w738-7hr3"]);
  });

  it("points out an entry whose advisory is no longer reported", () => {
    const verdict = judge(clean, clean, [entry("GHSA-7mx3-vvmw-hjmv")], TODAY);
    expect(verdict.ok).toBe(true);
    expect(verdict.unused.map((e) => e.id)).toEqual(["GHSA-7mx3-vvmw-hjmv"]);
  });
});

describe("isReport", () => {
  it("tells a report from the registry's error body", () => {
    expect(isReport(clean)).toBe(true);
    expect(isReport({ error: { code: "E503", summary: "Service Unavailable" } })).toBe(false);
    expect(isReport(null)).toBe(false);
  });
});

describe("parseAllowlist", () => {
  const list = (advisories: unknown[]) => JSON.stringify({ advisories });

  it("reads the committed list, and every entry has a date", () => {
    const entries = parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses an entry without a date", () => {
    expect(() => parseAllowlist(list([{ id: "GHSA-7mx3-vvmw-hjmv", package: "x", reason: "y" }]))).toThrow(/until/);
  });

  it("refuses an id that isn't one GHSA id, so a wildcard can't allow everything", () => {
    expect(() => parseAllowlist(list([{ ...entry("GHSA-7mx3-vvmw-hjmv"), id: "*" }]))).toThrow(/GHSA/);
    expect(() => parseAllowlist(list([{ ...entry("GHSA-7mx3-vvmw-hjmv"), id: "@graphql-tools/utils" }]))).toThrow(/GHSA/);
  });

  it("refuses an entry without a reason", () => {
    expect(() => parseAllowlist(list([{ ...entry("GHSA-7mx3-vvmw-hjmv"), reason: "" }]))).toThrow(/reason/);
  });

  it("refuses a file without an advisories array", () => {
    expect(() => parseAllowlist("{}")).toThrow(/advisories/);
  });
});
