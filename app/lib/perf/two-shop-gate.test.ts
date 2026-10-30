/**
 * The two-shop gate's verdict, judged offline (#813).
 *
 * The gate needs both live dev stores and a deployment to run, so the part that decides
 * pass or fail is tested here over recorded samples: a run that meets every SLO passes, the
 * 25 Sep run fails with each broken promise named, and a run that measured too little
 * fails rather than passing by default. And the gate refuses every store but the two it
 * was written for.
 */

import { describe, expect, it } from "vitest";

import {
  GATE_SHOPS,
  GATE_SLOS,
  GateShopRefusal,
  campaignRefusal,
  evaluateGate,
  gateShop,
  gateShops,
  summarise,
  type GateRecord,
  type PageSample,
  type RunSummary,
} from "./two-shop-gate";

const T = Date.UTC(2026, 9, 30, 10, 0, 0);
const LOAD = "anchor-perf.myshopify.com";
const OBSERVED = "dartmode-labs.myshopify.com";

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  status: "COMPLETED",
  writePath: "BULK",
  plannedRows: 102_132,
  verifiedRows: 102_132,
  failedRows: 0,
  createdAt: T,
  finishedAt: T + 132_000,
  startedBy: "page",
  ...over,
});

const probeRun = (over: Partial<RunSummary> = {}) =>
  run({ writePath: "SYNC", plannedRows: 3, verifiedRows: 3, ...over });

/** Ten minutes of pages every 10 s and health every 5 s, all quick: what passing looks like. */
function passing(): GateRecord {
  const pages: PageSample[] = [];
  for (let i = 0; i < 60; i++) {
    for (const page of ["home", "campaign", "prices"] as const) pages.push({ page, at: T + i * 10_000, ms: 300 + (i % 7) * 40, status: 200 });
  }
  const health = Array.from({ length: 120 }, (_, i) => [
    { target: "healthz" as const, at: T + i * 5_000, ms: 40 + (i % 5) * 10, status: 200, reported: "ok", databaseWaitMs: 2 },
    { target: "help" as const, at: T + i * 5_000, ms: 25, status: 200 },
  ]).flat();

  return {
    startedAt: T,
    finishedAt: T + 600_000,
    shops: { load: LOAD, observed: OBSERVED },
    load: { apply: run(), revert: run({ createdAt: T + 200_000, finishedAt: T + 360_000 }) },
    probes: [
      { kind: "apply", at: T + 30_000, ms: 4_200, run: probeRun(), duringLoad: true },
      { kind: "revert", at: T + 40_000, ms: 3_900, run: probeRun(), duringLoad: true },
      { kind: "apply", at: T + 250_000, ms: 5_100, run: probeRun(), duringLoad: true },
      { kind: "revert", at: T + 260_000, ms: 4_000, run: probeRun(), duringLoad: true },
    ],
    pages,
    health,
    poolErrors: { gateShops: 0, otherShops: 0, unattributed: 0 },
    driftEvents: 0,
    autoEnrolments: 0,
  };
}

const missed = (record: GateRecord) => evaluateGate(record).misses.map((miss) => miss.slo);

describe("a run that meets every SLO", () => {
  it("passes, with nothing missed and its numbers summarised", () => {
    const verdict = evaluateGate(passing());

    expect(verdict.misses).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(verdict.summary.observedPages.count).toBe(180);
    expect(verdict.summary.healthz.count).toBe(120);
    expect(verdict.summary.probeApplies).toMatchObject({ count: 2, max: 5_100 });
  });
});

describe("the 25 Sep run fails, and says why (#803)", () => {
  /**
   * What production did: pages blank for minutes, `/healthz` at 6.8-10.4 s while saying
   * "ok", the apply dying of a pool timeout part-way at 55,000 rows, the aftermath's echoes
   * read as drift (219 notifications in a minute, #806) and enrolled again (#805).
   */
  function twentyFifthOfSeptember(): GateRecord {
    const record = passing();
    record.pages = record.pages.map((sample, i) =>
      i % 3 === 1 ? { ...sample, ms: 9_000 } : i % 40 === 0 ? { ...sample, ms: 30_000, status: 502 } : sample,
    );
    record.health = record.health.map((sample) =>
      sample.target === "healthz" ? { ...sample, ms: 6_800 + (sample.at % 3_600), databaseWaitMs: 6_800, reported: "ok" } : sample,
    );
    record.load.apply = run({ status: "PARTIAL", verifiedRows: 55_000, failedRows: 47_132 });
    record.load.revert = null;
    record.probes = [{ kind: "apply", at: T + 30_000, ms: null, run: null, duringLoad: true }];
    record.poolErrors = { gateShops: 41, otherShops: 3, unattributed: 6 };
    record.driftEvents = 219;
    record.autoEnrolments = 2;
    return record;
  }

  it("fails on every promise it broke, not only the first", () => {
    expect(missed(twentyFifthOfSeptember()).sort()).toEqual(
      [
        "observed-pages-p95",
        "observed-pages-failed",
        "probe-apply-slow",
        "load-apply-unclean",
        "load-revert-unclean",
        "pool-timeouts",
        "self-echo-drift",
        "self-echo-enrolments",
        "healthz-p95",
      ].sort(),
    );
    expect(evaluateGate(twentyFifthOfSeptember()).passed).toBe(false);
  });

  it("points out a /healthz that said ok while it waited, which is how #803 hid", () => {
    expect(evaluateGate(twentyFifthOfSeptember()).notes.join(" ")).toMatch(
      /said "ok" 120 times while its SELECT 1 waited up to 6,800 ms: the #803 signature/,
    );
  });

  it("names the numbers in each miss, so a failing gate reads as a diagnosis", () => {
    const misses = Object.fromEntries(evaluateGate(twentyFifthOfSeptember()).misses.map((m) => [m.slo, m.detail]));

    expect(misses["observed-pages-p95"]).toMatch(/dartmode-labs\.myshopify\.com pages p95 9,000 ms .*worst was campaign/);
    expect(misses["observed-pages-failed"]).toMatch(/× 502/);
    expect(misses["probe-apply-slow"]).toContain("never settled");
    expect(misses["load-apply-unclean"]).toContain("PARTIAL with 55,000 of 102,132 verified and 47,132 failed");
    expect(misses["load-revert-unclean"]).toContain("no run was recorded");
    expect(misses["pool-timeouts"]).toContain("50 P2024 / DB_UNAVAILABLE");
    expect(misses["healthz-p95"]).toMatch(/\/healthz p95 \d{1,2},\d{3} ms/);
  });
});

describe("each SLO on its own", () => {
  it("fails a page p95 at the limit, which is 'under 2 s', not 'up to'", () => {
    const record = passing();
    record.pages = record.pages.map((sample) => ({ ...sample, ms: GATE_SLOS.observedPageP95Ms }));
    expect(missed(record)).toEqual(["observed-pages-p95"]);
  });

  it("fails a single 1-variant apply over 30 s even when the rest are quick", () => {
    const record = passing();
    record.probes[2] = { ...record.probes[2], ms: 31_000 };
    expect(missed(record)).toEqual(["probe-apply-slow"]);
  });

  it("fails a probe that was never pressed while the load was writing", () => {
    // Pressed after the load finished, it measured an idle app.
    const record = passing();
    record.probes = record.probes.map((probe) => ({ ...probe, duringLoad: false }));
    expect(missed(record)).toEqual(["probe-unmeasured"]);
  });

  it("fails a probe that settled but not clean", () => {
    const record = passing();
    record.probes[1] = { ...record.probes[1], run: probeRun({ status: "PARTIAL", failedRows: 1 }) };
    expect(missed(record)).toEqual(["probe-unclean"]);
  });

  it("fails a probe campaign that is not one variant, whose timings are not the SLO's", () => {
    const record = passing();
    record.probes[0] = { ...record.probes[0], run: probeRun({ plannedRows: 3_669, verifiedRows: 3_669 }) };
    expect(missed(record)).toEqual(["probe-not-small"]);
  });

  it("fails a load that was not the load: too small, or not on the bulk path", () => {
    const small = passing();
    small.load.apply = run({ plannedRows: 5_000, verifiedRows: 5_000 });
    expect(missed(small)).toEqual(["load-not-representative"]);

    const sync = passing();
    sync.load.apply = run({ writePath: "SYNC" });
    expect(missed(sync)).toEqual(["load-not-representative"]);
  });

  it("fails on a pool timeout anywhere -- another merchant's page is the epic's whole point", () => {
    const record = passing();
    record.poolErrors = { gateShops: 0, otherShops: 1, unattributed: 0 };
    expect(missed(record)).toEqual(["pool-timeouts"]);
  });

  it("fails on one self-echo drift event or one auto-enrolment", () => {
    const drift = passing();
    drift.driftEvents = 1;
    expect(missed(drift)).toEqual(["self-echo-drift"]);

    const enrolled = passing();
    enrolled.autoEnrolments = 1;
    expect(missed(enrolled)).toEqual(["self-echo-enrolments"]);
  });

  it("fails a /healthz that is slow, or that answered anything but 200", () => {
    const slow = passing();
    slow.health = slow.health.map((sample) => (sample.target === "healthz" ? { ...sample, ms: 1_200 } : sample));
    expect(missed(slow)).toEqual(["healthz-p95"]);

    const down = passing();
    down.health[0] = { ...down.health[0], status: 503 };
    expect(missed(down)).toEqual(["healthz-failed"]);
  });

  it("does not fail a /healthz that read degraded quickly, but says so", () => {
    // Degraded is a reading, not an outage; the SLO is that it answers within a second.
    const record = passing();
    record.health = record.health.map((sample) =>
      sample.target === "healthz" ? { ...sample, reported: "degraded", databaseWaitMs: 1_400 } : sample,
    );
    const verdict = evaluateGate(record);
    expect(verdict.passed).toBe(true);
    expect(verdict.notes.join(" ")).toMatch(/not "ok"; its SELECT 1 waited up to 1,400 ms/);
  });

  it("notes a slow no-database control, which points at the process rather than the pool", () => {
    const record = passing();
    record.health = record.health.map((sample) => (sample.target === "help" ? { ...sample, ms: 3_000 } : sample));
    const verdict = evaluateGate(record);
    expect(verdict.passed).toBe(true);
    expect(verdict.notes.join(" ")).toContain("the web process itself was slow");
  });
});

describe("a gate that measured nothing does not pass", () => {
  it("fails with no samples rather than reporting p95 0", () => {
    const record = passing();
    record.pages = [];
    record.health = [];
    record.probes = [];
    record.load = { apply: null, revert: null };

    expect(missed(record).sort()).toEqual(
      ["observed-pages-unmeasured", "healthz-unmeasured", "probe-unmeasured", "load-apply-unclean", "load-revert-unclean"].sort(),
    );
  });
});

describe("which stores the gate may touch", () => {
  it("accepts the two development stores in their own roles", () => {
    expect(gateShops(LOAD, OBSERVED)).toEqual({ load: LOAD, observed: OBSERVED });
    // DartMode Labs is boltify-apps.myshopify.com in docs/environments.md: one store, two names.
    expect(gateShops(LOAD, "boltify-apps.myshopify.com").observed).toBe("boltify-apps.myshopify.com");
  });

  it("refuses any other store in either role", () => {
    for (const stranger of ["some-merchant.myshopify.com", "anchor-perf-2.myshopify.com", "anchor-perf", ""]) {
      expect(() => gateShop("load", stranger), stranger).toThrow(GateShopRefusal);
      expect(() => gateShop("observed", stranger), stranger).toThrow(GateShopRefusal);
    }
  });

  it("refuses the stores in each other's roles, and one store in both", () => {
    expect(() => gateShops(OBSERVED, LOAD)).toThrow(/cannot be the load store/);
    expect(() => gateShop("observed", LOAD)).toThrow(/cannot be the observed store/);
    expect(() => gateShops(LOAD, LOAD)).toThrow(GateShopRefusal);
  });

  it("says which stores it would accept", () => {
    expect(() => gateShop("load", "some-merchant.myshopify.com")).toThrow(/load is anchor-perf\.myshopify\.com/);
    expect(GATE_SHOPS.load).toEqual(["anchor-perf.myshopify.com"]);
  });
});

describe("summarise", () => {
  it("is nearest-rank, as measure-concurrency reports it, and zero for no samples", () => {
    expect(summarise([5, 1, 3, 2, 4])).toEqual({ count: 5, p50: 3, p95: 5, max: 5 });
    expect(summarise([])).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });
  });
});

describe("the campaigns the gate will press", () => {
  const load = { status: "DRAFT", tagKit: ["anchor-gate"], priceLists: ["gid://shopify/PriceList/1"], hasEnd: false };
  const page = { apply: "page", revert: "page" } as const;

  it("takes a load campaign with a tag and markets on, with nothing live", () => {
    expect(campaignRefusal("load", load, page)).toBeNull();
    expect(campaignRefusal("load", { ...load, status: "COMPLETED" }, page)).toBeNull();
  });

  it("refuses a lighter load than the one 25 Sep ran", () => {
    expect(campaignRefusal("load", { ...load, tagKit: [] }, page)).toMatch(/adds no tag/);
    expect(campaignRefusal("load", { ...load, priceLists: [] }, page)).toMatch(/markets off/);
  });

  it("refuses to press Apply on a campaign whose prices may already be live", () => {
    for (const status of ["ACTIVE", "APPLYING", "PARTIAL", "HELD", "REVERTING"]) {
      expect(campaignRefusal("load", { ...load, status }, page), status).toMatch(/must be Draft or Completed/);
      expect(campaignRefusal("probe", { ...load, status }, page), status).toMatch(/must be Draft or Completed/);
    }
  });

  it("wants a scheduled campaign for a worker-started run, and an end date for a scheduled revert", () => {
    const scheduler = { apply: "scheduler", revert: "scheduler" } as const;
    expect(campaignRefusal("load", { ...load, status: "SCHEDULED", hasEnd: true }, scheduler)).toBeNull();
    expect(campaignRefusal("load", load, scheduler)).toMatch(/schedule it/);
    expect(campaignRefusal("load", { ...load, status: "SCHEDULED" }, scheduler)).toMatch(/no end date/);
  });
});
