/**
 * The two-shop concurrency gate's rules: which stores it may touch, and what passing means
 * (#813, Epic 19 step 6).
 *
 * Everything else in `docs/perf/` is one shop, one request at a time (#516), and the
 * failure on 25 Sep only exists with two shops at once: anchor-perf's 102,132-variant apply
 * ran the web pool dry and every *other* shop's pages went blank (#803). So the gate loads
 * one shop and measures the other. `scripts/gate-two-shops.ts` does the I/O -- presses
 * Apply and Revert, polls pages and `/healthz`, reads the run rows and Diagnostics -- and
 * hands this module a record. Everything that decides pass or fail is here, pure, so it is
 * tested without a store and a saved record can be re-judged offline (`--evaluate`).
 *
 * **A gate that passes because it measured nothing is worse than no gate**, so every SLO
 * that needs samples also needs enough of them, and the load has to have been the load:
 * the bulk path, over the whole perf catalogue.
 */

import { countOf, formatCount } from "../format/display";

/** Which store plays which part. Each role names the only stores allowed to play it. */
export const GATE_SHOPS = {
  /** The 102,132-variant store, which takes the 100% campaign. */
  load: ["anchor-perf.myshopify.com"],
  /**
   * The store whose pages and 1-variant campaign are measured. One store under two names:
   * `docs/environments.md` records DartMode Labs as `boltify-apps.myshopify.com`, while the
   * issue, the incident notes and the admin URL call it `dartmode-labs` -- so both are
   * accepted for this role and nothing else is.
   */
  observed: ["dartmode-labs.myshopify.com", "boltify-apps.myshopify.com"],
} as const;

export type GateRole = keyof typeof GATE_SHOPS;

export class GateShopRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateShopRefusal";
  }
}

/**
 * The domain, if it may play `role`; otherwise a refusal naming what may.
 *
 * Checked after `chooseShop` has turned what was typed into an installed store, so a
 * prefix cannot slip a different store past this: the gate writes 102,132 prices and
 * pages through a merchant's admin, and a real merchant's store must never be either.
 */
export function gateShop(role: GateRole, domain: string): string {
  const allowed: readonly string[] = GATE_SHOPS[role];
  if (allowed.includes(domain)) return domain;
  throw new GateShopRefusal(
    `${domain} cannot be the ${role} store. The two-shop gate runs only against the development stores ` +
      `it was written for: ${role} is ${allowed.join(" or ")}.`,
  );
}

/** Both roles, and two different stores -- one shop loading itself proves nothing. */
export function gateShops(load: string, observed: string): { load: string; observed: string } {
  const pair = { load: gateShop("load", load), observed: gateShop("observed", observed) };
  if (pair.load === pair.observed) throw new GateShopRefusal("The load and observed stores must be different stores.");
  return pair;
}

/** Who starts each of the load's runs: the gate pressing the page's button, or the scheduler. */
export interface LoadModes {
  apply: "page" | "scheduler";
  revert: "page" | "scheduler";
}

/** What the gate checks about a campaign before it presses anything. */
export interface CampaignFacts {
  status: string;
  tagKit: readonly string[];
  /** Market and B2B price lists the campaign targets; empty is markets off. */
  priceLists: readonly string[];
  hasEnd: boolean;
}

/**
 * Why a campaign cannot play its part, or null when it can.
 *
 * The load is the issue's: a tag and markets on, because the tag write and the market price
 * lists are the work the 25 Sep run did on top of the base prices, and a load without them
 * is a lighter load. It starts with nothing live -- Draft or Completed -- when the gate
 * presses Apply, or Scheduled when the scheduler is to start it, which is the worker-started
 * run #813 asks for: the one that starved the pages on 25 Sep with no web request involved.
 */
export function campaignRefusal(role: "load" | "probe", facts: CampaignFacts, modes: LoadModes): string | null {
  const idle = facts.status === "DRAFT" || facts.status === "COMPLETED";
  if (role === "probe") {
    return idle ? null : `The 1-variant campaign is ${facts.status}; it must be Draft or Completed, with nothing live.`;
  }
  if (facts.tagKit.length === 0) return "The load campaign adds no tag; give it one, as the 25 Sep campaign had.";
  if (facts.priceLists.length === 0) return "The load campaign has markets off; turn them on, as the 25 Sep campaign had.";
  if (modes.apply === "page" && !idle) {
    return `The load campaign is ${facts.status}; it must be Draft or Completed for the gate to press Apply.`;
  }
  if (modes.apply === "scheduler" && facts.status !== "SCHEDULED") {
    return `The load campaign is ${facts.status}; schedule it to start a few minutes out for --apply scheduler.`;
  }
  if (modes.revert === "scheduler" && !facts.hasEnd) {
    return "The load campaign has no end date, so the scheduler will never revert it; give it one for --revert scheduler.";
  }
  return null;
}

/** The SLOs from #813. A run fails if it misses any. */
export const GATE_SLOS = {
  /** Every observed-shop page load (Home, a campaign page, Prices), p95. */
  observedPageP95Ms: 2_000,
  /** The observed shop's 1-variant apply, end to end: press to verified. Every one. */
  probeApplyMs: 30_000,
  /** `/healthz`, p95. */
  healthzP95Ms: 1_000,
  /** The load has to be the load: at least this many rows planned, on the bulk path. */
  loadMinRows: 100_000,
  /** And the probe the probe: a 1-variant campaign plans a row per surface, a handful at most. */
  probeMaxRows: 10,
  /** Fewer samples than this and a p95 is an anecdote. Pages every 10 s, health every 5 s. */
  minPageSamples: 20,
  minHealthSamples: 20,
} as const;

export type GateSlos = { [K in keyof typeof GATE_SLOS]: number };

export type ObservedPage = "home" | "campaign" | "prices";

/** One observed-shop page load. `status` 0 is no answer at all: a timeout or a reset. */
export interface PageSample {
  page: ObservedPage;
  at: number;
  ms: number;
  status: number;
}

/** One poll of `/healthz` or of the no-database control, `/help`. */
export interface HealthSample {
  target: "healthz" | "help";
  at: number;
  ms: number;
  status: number;
  /** `/healthz`'s own word for itself, and how long its `SELECT 1` waited. */
  reported?: string;
  databaseWaitMs?: number;
}

/** A run, as its `campaign_runs` row ended. */
export interface RunSummary {
  status: string;
  writePath: string | null;
  plannedRows: number;
  verifiedRows: number;
  failedRows: number;
  createdAt: number;
  finishedAt: number | null;
  /** Who started it: the gate pressing the page's button, or the scheduler in the worker. */
  startedBy: "page" | "scheduler";
}

/** One press of the observed shop's 1-variant campaign. */
export interface ProbeSample {
  kind: "apply" | "revert";
  at: number;
  /** Press to settled, or null when it never settled inside the gate's patience. */
  ms: number | null;
  run: RunSummary | null;
  /** Whether the load was writing when this was pressed. */
  duringLoad: boolean;
}

export interface GateRecord {
  startedAt: number;
  finishedAt: number;
  shops: { load: string; observed: string };
  load: { apply: RunSummary | null; revert: RunSummary | null };
  probes: ProbeSample[];
  pages: PageSample[];
  health: HealthSample[];
  /** Diagnostics in the window: pool timeouts (P2024) and DB_UNAVAILABLE, any shop or none. */
  poolErrors: { gateShops: number; otherShops: number; unattributed: number };
  /** Drift events detected on either store in the window. Nobody edits during a gate, so each is a self-echo. */
  driftEvents: number;
  /** Auto-enrolments on either store in the window, for the same reason. */
  autoEnrolments: number;
}

/** A missed SLO, named so a failing gate says which promise it broke. */
export type SloId =
  | "observed-pages-p95"
  | "observed-pages-failed"
  | "observed-pages-unmeasured"
  | "probe-apply-slow"
  | "probe-unclean"
  | "probe-unmeasured"
  | "probe-not-small"
  | "load-apply-unclean"
  | "load-revert-unclean"
  | "load-not-representative"
  | "pool-timeouts"
  | "self-echo-drift"
  | "self-echo-enrolments"
  | "healthz-p95"
  | "healthz-failed"
  | "healthz-unmeasured";

export interface Miss {
  slo: SloId;
  detail: string;
}

export interface Latencies {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface Verdict {
  passed: boolean;
  misses: Miss[];
  /** Things worth reading that are not misses: the control, and what `/healthz` said. */
  notes: string[];
  summary: {
    observedPages: Latencies;
    byPage: Record<ObservedPage, Latencies>;
    healthz: Latencies;
    help: Latencies;
    probeApplies: Latencies;
  };
}

/**
 * Nearest-rank p50/p95/max, as `measure-concurrency` reports them, so the numbers in
 * `docs/perf/` are comparable with each other. Zeroes for an empty sample.
 */
export function summarise(samples: readonly number[]): Latencies {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

/** A run finished clean: every row read back and verified (CLAUDE.md rule 5). */
export function cleanRun(run: RunSummary | null): boolean {
  return run !== null && run.status === "COMPLETED" && run.failedRows === 0;
}

// Through the shared count helpers (#759), as every count the app prints is.
const ms = (n: number) => `${formatCount(Math.round(n))} ms`;
const plural = countOf;

function describeRun(run: RunSummary | null): string {
  if (!run) return "no run was recorded";
  return (
    `the run ended ${run.status} with ${formatCount(run.verifiedRows)} of ` +
    `${formatCount(run.plannedRows)} verified and ${formatCount(run.failedRows)} failed`
  );
}

/** How failures spread across status codes: "3 × 502, 1 × no answer". */
function statuses(samples: readonly { status: number }[]): string {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const key = sample.status === 0 ? "no answer" : String(sample.status);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([status, n]) => `${n} × ${status}`).join(", ");
}

/**
 * Pass or fail, with every miss named.
 *
 * Every SLO is checked, not the first one to fail: a gate that stops at "pages were slow"
 * hides whether the run also died of a pool timeout, which is a different fix.
 */
export function evaluateGate(record: GateRecord, slos: GateSlos = GATE_SLOS): Verdict {
  const misses: Miss[] = [];
  const notes: string[] = [];
  const miss = (slo: SloId, detail: string) => misses.push({ slo, detail });

  // The observed shop's pages, every one of them -- the tail after the revert included,
  // because #803's aftermath outlasted the run by 45 minutes.
  const failed = record.pages.filter((sample) => sample.status !== 200);
  const observedPages = summarise(record.pages.map((sample) => sample.ms));
  const byPage = Object.fromEntries(
    (["home", "campaign", "prices"] as const).map((page) => [
      page,
      summarise(record.pages.filter((sample) => sample.page === page).map((sample) => sample.ms)),
    ]),
  ) as Record<ObservedPage, Latencies>;

  if (record.pages.length < slos.minPageSamples) {
    miss(
      "observed-pages-unmeasured",
      `${record.pages.length} page loads were measured on ${record.shops.observed}; the gate needs ${slos.minPageSamples}.`,
    );
  } else if (observedPages.p95 >= slos.observedPageP95Ms) {
    const worst = (Object.entries(byPage) as [ObservedPage, Latencies][]).sort((a, b) => b[1].p95 - a[1].p95)[0];
    miss(
      "observed-pages-p95",
      `${record.shops.observed} pages p95 ${ms(observedPages.p95)} over ${observedPages.count} loads ` +
        `(limit ${ms(slos.observedPageP95Ms)}); worst was ${worst[0]} at p95 ${ms(worst[1].p95)}, max ${ms(worst[1].max)}.`,
    );
  }
  if (failed.length > 0) {
    miss(
      "observed-pages-failed",
      `${failed.length} of ${record.pages.length} ${record.shops.observed} page loads did not answer 200: ${statuses(failed)}.`,
    );
  }

  // The 1-variant campaign: every apply inside the budget, every press settled clean, and
  // at least one of them pressed while the load was writing -- otherwise it measured an
  // idle app.
  const applies = record.probes.filter((probe) => probe.kind === "apply");
  if (!applies.some((probe) => probe.duringLoad)) {
    miss(
      "probe-unmeasured",
      `No 1-variant apply on ${record.shops.observed} was pressed while ${record.shops.load} was writing.`,
    );
  }
  const slow = applies.filter((probe) => probe.ms === null || probe.ms >= slos.probeApplyMs);
  if (slow.length > 0) {
    miss(
      "probe-apply-slow",
      `${slow.length} of ${applies.length} 1-variant applies took ${ms(slos.probeApplyMs)} or more end to end: ` +
        slow.map((probe) => (probe.ms === null ? "never settled" : ms(probe.ms))).join(", ") +
        ".",
    );
  }
  const unclean = record.probes.filter((probe) => probe.ms !== null && !cleanRun(probe.run));
  if (unclean.length > 0) {
    miss(
      "probe-unclean",
      unclean.map((probe) => `a 1-variant ${probe.kind}: ${describeRun(probe.run)}`).join("; ") + ".",
    );
  }
  const big = record.probes.filter((probe) => probe.run && probe.run.plannedRows > slos.probeMaxRows);
  if (big.length > 0) {
    miss(
      "probe-not-small",
      `The probe campaign planned ${Math.max(...big.map((probe) => probe.run!.plannedRows))} rows; a 1-variant ` +
        `campaign plans at most ${slos.probeMaxRows}. Its timings are not the SLO's.`,
    );
  }

  // The load: both runs clean, and the run the SLO is about rather than a smaller one.
  if (!cleanRun(record.load.apply)) miss("load-apply-unclean", `${record.shops.load} apply: ${describeRun(record.load.apply)}.`);
  if (!cleanRun(record.load.revert)) miss("load-revert-unclean", `${record.shops.load} revert: ${describeRun(record.load.revert)}.`);
  const apply = record.load.apply;
  if (apply && (apply.writePath !== "BULK" || apply.plannedRows < slos.loadMinRows)) {
    miss(
      "load-not-representative",
      `The ${record.shops.load} apply planned ${formatCount(apply.plannedRows)} rows on the ` +
        `${apply.writePath ?? "unknown"} path; the gate needs at least ${formatCount(slos.loadMinRows)} on BULK.`,
    );
  }

  // Diagnostics. Any shop, not only the two: a pool timeout on a real merchant's page during
  // the gate is the exact failure the epic is about, and unattributed ones are the worker's.
  const pool = record.poolErrors;
  const poolTotal = pool.gateShops + pool.otherShops + pool.unattributed;
  if (poolTotal > 0) {
    miss(
      "pool-timeouts",
      `${poolTotal} P2024 / DB_UNAVAILABLE errors in the window: ${pool.gateShops} on the gate's stores, ` +
        `${pool.otherShops} on other stores, ${pool.unattributed} with no store.`,
    );
  }
  if (record.driftEvents > 0) {
    miss(
      "self-echo-drift",
      `${plural(record.driftEvents, "drift event")} on the gate's stores: the app's own writes read back as a merchant's edits.`,
    );
  }
  if (record.autoEnrolments > 0) {
    miss(
      "self-echo-enrolments",
      `${plural(record.autoEnrolments, "auto-enrolment")} on the gate's stores: the app's own writes enrolled products.`,
    );
  }

  // `/healthz`, and the control beside it.
  const healthz = record.health.filter((sample) => sample.target === "healthz");
  const help = record.health.filter((sample) => sample.target === "help");
  const healthzLatency = summarise(healthz.map((sample) => sample.ms));
  const helpLatency = summarise(help.map((sample) => sample.ms));

  if (healthz.length < slos.minHealthSamples) {
    miss("healthz-unmeasured", `${healthz.length} /healthz polls were measured; the gate needs ${slos.minHealthSamples}.`);
  } else if (healthzLatency.p95 >= slos.healthzP95Ms) {
    miss(
      "healthz-p95",
      `/healthz p95 ${ms(healthzLatency.p95)} over ${healthzLatency.count} polls (limit ${ms(slos.healthzP95Ms)}), max ${ms(healthzLatency.max)}.`,
    );
  }
  const healthzFailed = healthz.filter((sample) => sample.status !== 200);
  if (healthzFailed.length > 0) {
    miss("healthz-failed", `${healthzFailed.length} of ${healthz.length} /healthz polls did not answer 200: ${statuses(healthzFailed)}.`);
  }

  // Not misses, but the first thing to read beside one. `/help` touches no database, so
  // when it is slow too the web process itself was slow -- the event loop, not the pool.
  if (help.length > 0 && helpLatency.p95 >= slos.healthzP95Ms) {
    notes.push(
      `The no-database control /help had p95 ${ms(helpLatency.p95)} too, so the web process itself was slow, not only its pool.`,
    );
  }
  // The #803 signature: "ok" in the body while its own query waited seconds. A deployment
  // that says this predates the latency-aware check, and its "ok" is not evidence.
  const okButWaiting = healthz.filter(
    (sample) => sample.reported === "ok" && (sample.databaseWaitMs ?? 0) > slos.healthzP95Ms,
  );
  if (okButWaiting.length > 0) {
    notes.push(
      `/healthz said "ok" ${plural(okButWaiting.length, "time")} while its SELECT 1 waited up to ` +
        `${ms(Math.max(...okButWaiting.map((sample) => sample.databaseWaitMs!)))}: the #803 signature, from a ` +
        "deployment without #813's latency-aware check.",
    );
  }
  const degraded = healthz.filter((sample) => sample.reported && sample.reported !== "ok");
  if (degraded.length > 0) {
    const waits = healthz.map((sample) => sample.databaseWaitMs).filter((n): n is number => typeof n === "number");
    notes.push(
      `/healthz read ${degraded.length} of ${healthz.length} polls as not "ok"` +
        (waits.length ? `; its SELECT 1 waited up to ${ms(Math.max(...waits))}.` : "."),
    );
  }

  return {
    passed: misses.length === 0,
    misses,
    notes,
    summary: {
      observedPages,
      byPage,
      healthz: healthzLatency,
      help: helpLatency,
      probeApplies: summarise(applies.filter((probe) => probe.ms !== null).map((probe) => probe.ms!)),
    },
  };
}
