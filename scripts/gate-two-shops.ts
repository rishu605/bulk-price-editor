#!/usr/bin/env tsx
/**
 * The two-shop concurrency gate (#813, Epic 19 step 6): one shop's 100k-variant run, and
 * SLOs for another shop while it runs.
 *
 *   APP_URL=https://<web-domain> npm run gate:two-shops -- \
 *     --load-campaign <id> --probe-campaign <id> [--observed-shop boltify-apps] \
 *     [--apply page|scheduler] [--revert page|scheduler] [--tail 300] [--out gate.json]
 *
 *   npm run gate:two-shops -- --evaluate gate.json     # re-judge a saved record, offline
 *
 * Everything in `docs/perf/` before this was one shop, one request at a time (#516), and the
 * failure on 25 Sep only exists with two shops at once: anchor-perf's 102,132-variant apply
 * ran the web pool dry and every other shop's pages went blank (#803). So, at once:
 *
 *   1. anchor-perf applies its 100% campaign (bulk path, a tag, markets on), then reverts it
 *      -- pressed on its page like a merchant, or started by the scheduler (`--apply
 *      scheduler`), which is the worker-started run that starved the pages on 25 Sep with
 *      no web request involved;
 *   2. the observed store loads Home, the probe campaign's page and Prices every 10 s, and
 *      applies and reverts its 1-variant campaign over and over, timing each press to
 *      verified;
 *   3. `/healthz` and the no-database control `/help` are polled every 5 s.
 *
 * Then it reads the runs and Diagnostics and hands the record to `evaluateGate`
 * (`app/lib/perf/two-shop-gate.ts`), where the SLOs and the store allowlist live and are
 * tested. Exit 1 on any miss. See `docs/perf/two-shop-gate.md` for when to run it.
 *
 * **What it touches.** Writes go only through the app's own page actions, signed as staff
 * user 1 the way App Bridge signs them (`test-page-actor` does the same): the gate is a
 * merchant pressing buttons, not a second writer. The database is only read -- the run rows,
 * `error_events`, `drift_events`, the audit log -- so `DATABASE_URL` should be a read-only
 * role on the environment under test. It refuses any store but the two development stores.
 *
 * Needs, all for the deployment under test: APP_URL (its public URL), SHOPIFY_API_KEY and
 * SHOPIFY_API_SECRET (to sign session tokens), DATABASE_URL.
 */

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import prisma from "../app/db.server";
import { parseSurfaces } from "../app/lib/campaigns/surfaces";
import { PRICES_MAY_BE_LIVE, type CampaignState } from "../app/lib/lifecycle/transitions";
import {
  campaignRefusal,
  evaluateGate,
  gateShops,
  type GateRecord,
  type HealthSample,
  type LoadModes,
  type ObservedPage,
  type PageSample,
  type ProbeSample,
  type RunSummary,
  type Verdict,
} from "../app/lib/perf/two-shop-gate";
import { chooseShop } from "../app/lib/seed/target-shop";

const STAFF = "1";
const HEALTH_EVERY_MS = 5_000;
const PAGES_EVERY_MS = 10_000;
/** A request that has not answered by now is recorded as no answer, at this duration. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Between one probe cycle and the next, so the probe is a merchant rather than a load. */
const PROBE_GAP_MS = 30_000;
const PROBE_SETTLE_MS = 5 * 60_000;
const TERMINAL_RUN = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
const CLAIMED = new Set(["APPLYING", "REVERTING"]);
// The library answers a self-identified bot -- Node's own "node" included -- with 410.
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Shop {
  id: string;
  domain: string;
}

async function main(): Promise<void> {
  const saved = flag("--evaluate");
  if (saved) return report(evaluateGate(JSON.parse(readFileSync(saved, "utf8")) as GateRecord));

  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  const key = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!appUrl || !key || !secret || !process.env.DATABASE_URL) {
    throw new Error("APP_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET and DATABASE_URL are required, all for the deployment under test");
  }
  const loadCampaignId = flag("--load-campaign");
  const probeCampaignId = flag("--probe-campaign");
  if (!loadCampaignId || !probeCampaignId) throw new Error("--load-campaign <id> and --probe-campaign <id> are required");
  const modes: LoadModes = {
    apply: flag("--apply") === "scheduler" ? "scheduler" : "page",
    revert: flag("--revert") === "scheduler" ? "scheduler" : "page",
  };
  const tailMs = Number(flag("--tail") ?? 300) * 1000;
  const loadTimeoutMs = Number(flag("--timeout") ?? 90) * 60_000;

  // Named, never guessed, and then held to the allowlist -- `chooseShop` turns what was
  // typed into an installed store, `gateShops` refuses every store but the two.
  const installed = await prisma.shop.findMany({ where: { uninstalledAt: null }, select: { id: true, domain: true } });
  const pair = gateShops(
    chooseShop(installed, flag("--load-shop") ?? "anchor-perf").domain,
    chooseShop(installed, flag("--observed-shop") ?? "dartmode-labs").domain,
  );
  const load = installed.find((shop) => shop.domain === pair.load)!;
  const observed = installed.find((shop) => shop.domain === pair.observed)!;

  await refuseUnlessReady("load", load, loadCampaignId, modes);
  await refuseUnlessReady("probe", observed, probeCampaignId, modes);

  const token = (shop: Shop) => sessionToken(shop.domain, key, secret);
  const pagePaths: Record<ObservedPage, string> = {
    home: "/app.data",
    campaign: `/app/campaigns/${probeCampaignId}.data`,
    prices: "/app/prices.data",
  };

  // Fail before anything is pressed if the deployment or the signature is wrong: a gate
  // that discovers a bad secret an hour into a 100k run has wasted the run.
  const preflight = await timed(`${appUrl}/healthz`);
  if (preflight.status !== 200) throw new Error(`${appUrl}/healthz answered ${preflight.status || "nothing"}; is APP_URL right?`);
  const signed = await timed(`${appUrl}${pagePaths.home}`, { headers: authorised(token(observed)) });
  if (signed.status !== 200) {
    throw new Error(`Home on ${observed.domain} answered ${signed.status || "nothing"}: is SHOPIFY_API_SECRET this deployment's, and is the app installed there?`);
  }

  const record: GateRecord = {
    startedAt: Date.now(),
    finishedAt: 0,
    shops: pair,
    load: { apply: null, revert: null },
    probes: [],
    pages: [],
    health: [],
    poolErrors: { gateShops: 0, otherShops: 0, unattributed: 0 },
    driftEvents: 0,
    autoEnrolments: 0,
  };
  // Interrupted, the gate still says what it leaves behind: 102,132 discounted prices on the
  // perf store is a state somebody needs to know about before the next measurement.
  process.once("SIGINT", () => {
    console.log("\ninterrupted");
    void warnIfLive([[load, loadCampaignId], [observed, probeCampaignId]]).finally(() => process.exit(130));
  });
  console.log(`two-shop gate: ${load.domain} loads, ${observed.domain} is measured, against ${appUrl}`);
  console.log(`  load apply by ${modes.apply}, revert by ${modes.revert}; tail ${tailMs / 1000}s\n`);

  let sampling = true;
  let loadWriting = false;
  let loadDone = false;

  const health = every(HEALTH_EVERY_MS, () => sampling, async () => {
    const [healthz, help] = await Promise.all([timed(`${appUrl}/healthz`), timed(`${appUrl}/help`)]);
    const body = parse(healthz.text) as { status?: string; database?: { waitMs?: number } } | null;
    const sample: HealthSample = { target: "healthz", at: healthz.at, ms: healthz.ms, status: healthz.status };
    if (body?.status) sample.reported = body.status;
    if (typeof body?.database?.waitMs === "number") sample.databaseWaitMs = body.database.waitMs;
    record.health.push(sample, { target: "help", at: help.at, ms: help.ms, status: help.status });
  });

  // One after another, as a merchant clicks: Home, the campaign, Prices.
  const pages = every(PAGES_EVERY_MS, () => sampling, async () => {
    for (const page of ["home", "campaign", "prices"] as const) {
      const answer = await timed(`${appUrl}${pagePaths[page]}`, { headers: authorised(token(observed)) });
      const sample: PageSample = { page, at: answer.at, ms: answer.ms, status: answer.status };
      record.pages.push(sample);
      if (answer.status !== 200 || answer.ms >= 2_000) console.log(`  ${observed.domain} ${page}: ${answer.status || "no answer"} in ${answer.ms} ms`);
    }
  });

  /** One press of a campaign page's own Apply or Revert -- the merchant's button. */
  const press = async (shop: Shop, campaignId: string, intent: "apply" | "revert") => {
    const body = new URLSearchParams({ intent, confirmation: "apply" });
    const answer = await timed(`${appUrl}/app/campaigns/${campaignId}.data`, {
      method: "POST",
      headers: { ...authorised(token(shop)), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, 6 * 60_000);
    if (answer.status !== 200) console.log(`  ${shop.domain} ${intent}: HTTP ${answer.status || "no answer"} -- ${answer.text.slice(0, 200)}`);
    return answer;
  };

  /** The load's run of this kind, pressed or awaited, to the end. */
  const loadRun = async (kind: "apply" | "revert"): Promise<RunSummary | null> => {
    const before = await runIds(loadCampaignId);
    const startedBy = modes[kind];
    if (startedBy === "page") {
      loadWriting = true;
      await press(load, loadCampaignId, kind);
    } else {
      console.log(`  waiting for the scheduler to ${kind} ${load.domain}'s campaign`);
    }
    const run = await settled(loadCampaignId, kind, before, {
      timeoutMs: loadTimeoutMs,
      pollMs: 10_000,
      startedBy,
      // The scheduler's run is in flight from the moment its row exists, not from when the
      // gate started waiting for it.
      onStarted: () => (loadWriting = true),
    });
    loadWriting = false;
    console.log(`  ${load.domain} ${kind}: ${run ? `${run.status}, ${run.verifiedRows}/${run.plannedRows} verified on ${run.writePath}` : "never settled"}`);
    return run;
  };

  // The probe, over and over while the load runs: apply, verified, revert, verified. It
  // starts once the load is in flight -- pressed, or seen started by the scheduler -- since
  // a probe of an idle app measures nothing the gate is for.
  const probes = (async () => {
    while (!loadWriting && !loadDone) await sleep(500);
    while (!loadDone) {
      for (const kind of ["apply", "revert"] as const) {
        const before = await runIds(probeCampaignId);
        const at = Date.now();
        const duringLoad = loadWriting;
        await press(observed, probeCampaignId, kind);
        const run = await settled(probeCampaignId, kind, before, { timeoutMs: PROBE_SETTLE_MS, pollMs: 500, startedBy: "page" });
        // Press to settled, as the merchant waits it: half a second of polling resolution,
        // well inside a 30 s budget.
        const probe: ProbeSample = { kind, at, ms: run ? Date.now() - at : null, run, duringLoad };
        record.probes.push(probe);
        console.log(`  ${observed.domain} 1-variant ${kind}: ${probe.ms === null ? "never settled" : `${probe.ms} ms`}, ${run?.status ?? "no run"}`);
        // An apply that never settled leaves nothing to revert, and pressing on would only
        // stack presses on a campaign that is still claimed.
        if (!run) return;
      }
      await sleep(PROBE_GAP_MS);
    }
  })();

  try {
    record.load.apply = await loadRun("apply");
    if (cleanEnough(record.load.apply)) record.load.revert = await loadRun("revert");
  } finally {
    loadDone = true;
    await probes;
    // The aftermath, measured too: #803's echoes kept the app at the timeout for 45+ minutes
    // after the run itself was over.
    console.log(`  load finished; sampling the aftermath for ${tailMs / 1000}s`);
    await sleep(tailMs);
    sampling = false;
    await Promise.all([health, pages]);
    record.finishedAt = Date.now();
  }

  await readDiagnostics(record, [load.id, observed.id]);
  const out = flag("--out");
  if (out) {
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nrecord written to ${out}; re-judge it with --evaluate ${out}`);
  }
  await warnIfLive([[load, loadCampaignId], [observed, probeCampaignId]]);
  report(evaluateGate(record));
}

/** Refuses a campaign that is on the wrong store, or cannot play its part. */
async function refuseUnlessReady(role: "load" | "probe", shop: Shop, campaignId: string, modes: LoadModes): Promise<void> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id },
    select: { status: true, tagKit: true, surfaces: true, endAt: true, name: true },
  });
  if (!campaign) throw new Error(`No campaign ${campaignId} on ${shop.domain}: the ${role} campaign must belong to that store.`);
  const refusal = campaignRefusal(
    role,
    { status: campaign.status, tagKit: campaign.tagKit, priceLists: parseSurfaces(campaign.surfaces).priceLists, hasEnd: campaign.endAt !== null },
    modes,
  );
  if (refusal) throw new Error(`${shop.domain} "${campaign.name}": ${refusal}`);
}

/** The campaign's runs before a press, so the press's own run is the one not among them. */
async function runIds(campaignId: string): Promise<Set<string>> {
  const runs = await prisma.campaignRun.findMany({ where: { campaignId }, select: { id: true } });
  return new Set(runs.map((run) => run.id));
}

/**
 * The new run of this kind, once it has ended and the campaign has let go of its claim.
 *
 * "New" by id rather than by time: the run row is stamped by the app's clock and this
 * reads it from another machine's, and a run created inside the skew would be missed.
 */
async function settled(
  campaignId: string,
  kind: "apply" | "revert",
  before: Set<string>,
  options: { timeoutMs: number; pollMs: number; startedBy: RunSummary["startedBy"]; onStarted?: () => void },
): Promise<RunSummary | null> {
  const deadline = Date.now() + options.timeoutMs;
  let started = false;
  while (Date.now() < deadline) {
    const [run, campaign] = await Promise.all([
      prisma.campaignRun.findFirst({
        where: { campaignId, kind: kind === "apply" ? "APPLY" : "REVERT", id: { notIn: [...before] } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }),
    ]);
    if (run && !started) {
      started = true;
      options.onStarted?.();
    }
    if (run && TERMINAL_RUN.has(run.status) && campaign && !CLAIMED.has(campaign.status)) {
      return {
        status: run.status,
        writePath: run.writePath,
        plannedRows: run.plannedRows,
        verifiedRows: run.verifiedRows,
        failedRows: run.failedRows,
        createdAt: run.createdAt.getTime(),
        finishedAt: run.finishedAt?.getTime() ?? null,
        startedBy: options.startedBy,
      };
    }
    await sleep(options.pollMs);
  }
  return null;
}

/** A revert is worth pressing after any apply that wrote something, clean or not. */
function cleanEnough(run: RunSummary | null): boolean {
  return run !== null && run.verifiedRows + run.failedRows > 0;
}

/**
 * Diagnostics for the window, padded either side by the clock skew the run lookup avoids.
 * Pool timeouts on any store count -- another merchant's blank page is the epic's point.
 */
async function readDiagnostics(record: GateRecord, gateShopIds: string[]): Promise<void> {
  const window = { gte: new Date(record.startedAt - 30_000), lte: new Date(record.finishedAt + 30_000) };
  const pool = { createdAt: window, OR: [{ code: "DB_UNAVAILABLE" }, { message: { contains: "P2024" } }] };
  const [gate, other, none, drift, enrolled] = await Promise.all([
    prisma.errorEvent.count({ where: { ...pool, shopId: { in: gateShopIds } } }),
    prisma.errorEvent.count({ where: { ...pool, AND: [{ shopId: { not: null } }, { shopId: { notIn: gateShopIds } }] } }),
    prisma.errorEvent.count({ where: { ...pool, shopId: null } }),
    prisma.driftEvent.count({ where: { shopId: { in: gateShopIds }, detectedAt: window } }),
    prisma.auditLogEntry.count({ where: { shopId: { in: gateShopIds }, action: "campaign.auto_enroll", createdAt: window } }),
  ]);
  record.poolErrors = { gateShops: gate, otherShops: other, unattributed: none };
  record.driftEvents = drift;
  record.autoEnrolments = enrolled;
}

/** Says so when the gate leaves prices up: an aborted run, or a revert that never settled. */
async function warnIfLive(campaigns: Array<[Shop, string]>): Promise<void> {
  for (const [shop, campaignId] of campaigns) {
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true, name: true } });
    if (campaign && PRICES_MAY_BE_LIVE.has(campaign.status as CampaignState)) {
      console.log(`\n  WARNING: ${shop.domain} "${campaign.name}" is ${campaign.status}; its prices may be live. Revert it from its page.`);
    }
  }
}

function report(verdict: Verdict): void {
  const row = (label: string, l: { count: number; p50: number; p95: number; max: number }) =>
    console.log(`  ${label.padEnd(26)} ${String(l.count).padStart(5)}   p50 ${String(l.p50).padStart(6)} ms   p95 ${String(l.p95).padStart(6)} ms   max ${String(l.max).padStart(6)} ms`);
  console.log("\n  measured                   count");
  row("observed pages", verdict.summary.observedPages);
  for (const [page, latencies] of Object.entries(verdict.summary.byPage)) row(`  ${page}`, latencies);
  row("1-variant applies", verdict.summary.probeApplies);
  row("/healthz", verdict.summary.healthz);
  row("/help (no-database control)", verdict.summary.help);
  for (const note of verdict.notes) console.log(`\n  note: ${note}`);
  if (verdict.passed) {
    console.log("\nGATE PASSED");
    return;
  }
  console.log(`\nGATE FAILED -- ${verdict.misses.length} SLO(s) missed:`);
  for (const miss of verdict.misses) console.log(`  ${miss.slo}: ${miss.detail}`);
  process.exitCode = 1;
}

/** Runs `tick` every `ms` while `go()`; a slow tick delays the next rather than piling up. */
async function every(ms: number, go: () => boolean, tick: () => Promise<void>): Promise<void> {
  while (go()) {
    const started = Date.now();
    await tick();
    await sleep(Math.max(0, started + ms - Date.now()));
  }
}

/** A request, timed to the last byte. Status 0 is no answer inside the timeout. */
async function timed(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const at = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      headers: { "User-Agent": BROWSER, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { at, ms: Date.now() - at, status: response.status, text };
  } catch (error) {
    return { at, ms: Date.now() - at, status: 0, text: error instanceof Error ? error.message : String(error) };
  }
}

function authorised(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * An App Bridge session token for staff user `STAFF`: HS256 over the app's secret, as
 * `test-page-actor` signs one. Minted per request, so a long gate never presents an expired one.
 */
function sessionToken(shop: string, key: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: key,
    sub: STAFF,
    exp: now + 60,
    nbf: now - 5,
    iat: now,
    jti: randomUUID(),
    sid: randomUUID(),
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// Only when run as a script, as `measure-concurrency` and `drill-mirror` guard themselves:
// importing this must never start a gate.
if (process.argv[1]?.includes("gate-two-shops")) {
  main()
    .catch((error: unknown) => {
      console.error("\nERROR:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
