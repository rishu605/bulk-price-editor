/**
 * How many database connections a process may hold.
 *
 * Prisma's default is `num_physical_cpus * 2 + 1`, read from whatever container the
 * process lands on. That is a poor thing to leave implicit here for two reasons.
 *
 * **There are two pools, not one.** The web service and the worker each construct a
 * client, and each would size itself from its own container's CPU count with nothing
 * accounting for their sum against Postgres's `max_connections`. The number nobody chose
 * is the one that has to fit.
 *
 * **Exhaustion does not fail cleanly.** Postgres refuses the connection and the failure
 * surfaces wherever the next query happened to be — including inside a run that is part
 * way through writing prices. The inline budget exists because a request that outlives
 * its dyno leaves writes in flight with nobody reading the result; a pool that runs out
 * mid-apply is the same failure reached a different way.
 *
 * ## Where 10 comes from
 *
 * Measured, not guessed — `npm run measure:concurrency` against 102,132 variants. Twenty
 * merchants paging the catalogue at once, which is the traffic that actually wants
 * connections:
 *
 *   pool  1 → 200 pages, p50 691ms
 *   pool  2 → 220 pages, p50 571ms
 *   pool 10 → 290 pages, p50 347ms
 *   pool 21 → 316 pages, p50 301ms
 *   pool 40 → 318 pages, p50 290ms
 *
 * Ten buys 91% of the throughput available at 40, for a quarter of the connections. The
 * curve is flat enough past it that the remaining 9% is not worth spending the budget
 * that a second web replica, the boot-time `migrate deploy`, and somebody with `psql`
 * all draw from.
 *
 * Campaign planning wants far less. The scheduler walks due campaigns in a `for` loop
 * with an `await` in it, inside a worker holding a cluster lock, so a worker plans one
 * campaign at a time — and under four concurrent whole-catalogue plans, admin p95 was the
 * same at pool 2 as at pool 40. The same ten therefore covers the worker with room to
 * spare, and one number is easier to reason about than two.
 *
 * ## Why one number stopped being enough (#810)
 *
 * The worker's pool turned out to be the one a run lives in, and #803 measured what that
 * costs a page sharing it: `SELECT 1` waiting 9–12 s for forty minutes behind a 102k-variant
 * run, and the run's own writes dying of P2024. Each process now has its own size (still 10
 * when nothing says otherwise), the web process can have a short pool timeout and a statement
 * timeout of its own, and the boot check adds every pool up against `max_connections`.
 */

/** Connections per process, absent an explicit override. */
export const DEFAULT_POOL_SIZE = 10;

/**
 * Connections kept free for whatever is not a pool: the `migrate deploy` the web service
 * runs at boot, somebody with `psql`, Railway's own dashboard (#810). Counted in the
 * budget, never opened by this app.
 */
export const DEFAULT_POOL_RESERVE = 5;

/**
 * Which kind of process this is, for the pool it gets (#810).
 *
 * Two pools that used to be one number. #803 measured why that stopped being enough: one
 * 102k-variant run held the pool, `/healthz`'s `SELECT 1` waited 9–12 s for forty minutes,
 * and the run's own writes died of P2024. A page and a run want opposite things from a
 * pool -- a page would rather fail in a second with a sentence than wait ten behind a run,
 * and a run would rather wait than fail -- so they are sized, and timed out, separately.
 */
export type ProcessRole = "web" | "worker";

/** What one process's client is built with. Every field is a number somebody chose. */
export interface PoolSettings {
  role: ProcessRole;
  /** Prisma's `connection_limit`: the most connections this process holds at once. */
  connectionLimit: number;
  /**
   * Prisma's `pool_timeout`, in whole seconds -- Prisma refuses a fraction as a malformed
   * connection string. Unset leaves Prisma's 10 s, which is what both processes had
   * before #810.
   */
  poolTimeoutS?: number;
  /**
   * Postgres's `statement_timeout`, in milliseconds. Web only: a page that cannot be
   * answered in this long fails with a named error rather than holding a connection a
   * run is waiting for. Never the worker's, whose statements are a run's writes, and
   * never a migration's, which does not come through this client at all.
   */
  statementTimeoutMs?: number;
}

/**
 * The environment the pools are sized from, read in one place.
 *
 * Each key spelled out as `process.env.NAME` rather than looped over, so the runbook test
 * that collects every variable the app reads (`deploy-config.test.ts`) sees all of them.
 */
export interface PoolEnv {
  DATABASE_POOL_SIZE?: string;
  DATABASE_POOL_SIZE_WEB?: string;
  DATABASE_POOL_SIZE_WORKER?: string;
  DATABASE_POOL_RESERVE?: string;
  WEB_REPLICAS?: string;
  DATABASE_POOL_TIMEOUT_WEB_S?: string;
  DATABASE_STATEMENT_TIMEOUT_WEB_MS?: string;
}

export function poolEnv(): PoolEnv {
  return {
    DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE,
    DATABASE_POOL_SIZE_WEB: process.env.DATABASE_POOL_SIZE_WEB,
    DATABASE_POOL_SIZE_WORKER: process.env.DATABASE_POOL_SIZE_WORKER,
    DATABASE_POOL_RESERVE: process.env.DATABASE_POOL_RESERVE,
    WEB_REPLICAS: process.env.WEB_REPLICAS,
    DATABASE_POOL_TIMEOUT_WEB_S: process.env.DATABASE_POOL_TIMEOUT_WEB_S,
    DATABASE_STATEMENT_TIMEOUT_WEB_MS: process.env.DATABASE_STATEMENT_TIMEOUT_WEB_MS,
  };
}

/** A positive whole number, or nothing: a typo in a tuning knob falls back rather than throwing. */
function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const asked = Number(value);
  return Number.isInteger(asked) && asked > 0 ? asked : undefined;
}

/** A whole number of zero or more, for the reserve, where none is a legitimate answer. */
function wholeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const asked = Number(value);
  return Number.isInteger(asked) && asked >= 0 ? asked : undefined;
}

/**
 * One process's pool, from the environment (#810).
 *
 * Unset, every process gets what it had before: `DATABASE_POOL_SIZE` or 10 connections,
 * Prisma's 10 s pool timeout, no statement timeout. The per-role variables win over the
 * shared one, so a deploy can size the two services apart without unsetting the old knob.
 *
 * The timeouts are not defaulted on, though #810 recommends them, because neither is
 * clearly safer for every deploy: the web process also writes -- Apply, Revert and Resume
 * run inline (rule 2) -- and a statement timeout chosen without looking at what those
 * inline writes cost on that database turns a slow page into a failed run.
 */
export function poolSettings(role: ProcessRole, env: PoolEnv = poolEnv()): PoolSettings {
  const shared = positiveInt(env.DATABASE_POOL_SIZE) ?? DEFAULT_POOL_SIZE;
  if (role === "worker") {
    return { role, connectionLimit: positiveInt(env.DATABASE_POOL_SIZE_WORKER) ?? shared };
  }
  return {
    role,
    connectionLimit: positiveInt(env.DATABASE_POOL_SIZE_WEB) ?? shared,
    poolTimeoutS: positiveInt(env.DATABASE_POOL_TIMEOUT_WEB_S),
    statementTimeoutMs: positiveInt(env.DATABASE_STATEMENT_TIMEOUT_WEB_MS),
  };
}

/**
 * Every connection the deployment can open, as configured (#810).
 *
 * Web replicas each hold a full web pool, so they are multiplied in; the worker runs one
 * replica (see the runbook). The reserve is the headroom: connections nothing in this app
 * opens, kept for the migration at boot and for a person.
 */
export interface PoolBudget {
  web: number;
  webReplicas: number;
  worker: number;
  reserve: number;
  total: number;
}

export function poolBudget(env: PoolEnv = poolEnv()): PoolBudget {
  const web = poolSettings("web", env).connectionLimit;
  const worker = poolSettings("worker", env).connectionLimit;
  const webReplicas = positiveInt(env.WEB_REPLICAS) ?? 1;
  const reserve = wholeNumber(env.DATABASE_POOL_RESERVE) ?? DEFAULT_POOL_RESERVE;
  return { web, webReplicas, worker, reserve, total: web * webReplicas + worker + reserve };
}

/** What the database says it allows, read at boot. */
export interface ServerLimits {
  maxConnections: number;
  /**
   * Slots only a superuser may take: `superuser_reserved_connections`, plus Postgres 16's
   * `reserved_connections`. This app's role is not a superuser, so they are not its.
   */
  reserved: number;
}

export interface BudgetVerdict {
  fits: boolean;
  /** Connections this app's role can actually open. */
  available: number;
  /** What is left over once every pool and the reserve are full. Negative means over. */
  headroom: number;
  /** One line, for the boot log: the sum, the limit, and what to change. */
  summary: string;
}

/**
 * Whether every pool fits under `max_connections` with the reserve to spare (#810).
 *
 * Fitting is the sum against what the role can open, not against `max_connections`
 * itself: the superuser slots are there, and counting them would let the last pool to
 * connect be refused while the arithmetic said there was room.
 */
export function judgeBudget(budget: PoolBudget, server: ServerLimits): BudgetVerdict {
  const available = server.maxConnections - server.reserved;
  const headroom = available - budget.total;
  const sum =
    `web ${budget.web}${budget.webReplicas > 1 ? ` × ${budget.webReplicas} replicas` : ""} + ` +
    `worker ${budget.worker} + reserve ${budget.reserve} = ${budget.total}`;
  const limit = `max_connections ${server.maxConnections} − ${server.reserved} reserved for superusers = ${available}`;
  return headroom >= 0
    ? { fits: true, available, headroom, summary: `${sum}, within ${limit} (${headroom} spare)` }
    : {
        fits: false,
        available,
        headroom,
        summary:
          `${sum}, over ${limit} by ${-headroom}. Lower DATABASE_POOL_SIZE_WEB or ` +
          "DATABASE_POOL_SIZE_WORKER, or move to a Postgres plan with more connections: under load " +
          "the last process to connect is refused, wherever its next query happens to be.",
      };
}

/**
 * The connection string for one process: its pool size, and its timeouts where it has any.
 *
 * Anything already on the URL wins, as `connection_limit` always has: whoever set it on
 * the Railway variable meant it. A statement timeout is passed as a startup option
 * (`options=-c statement_timeout=…`), which Prisma forwards to Postgres -- except behind
 * PgBouncer (`pgbouncer=true`), where transaction pooling refuses or drops startup options,
 * so it is left off the URL and has to be set on the web service's database role. The boot
 * check reads the session's `statement_timeout` back and says when it is not what was asked.
 */
export function connectionUrl(databaseUrl: string | undefined, settings: PoolSettings): string | undefined {
  // The size first, with `poolUrl`'s precedence: a `connection_limit` on the URL wins, and
  // a string that is not a URL comes back untouched for Prisma to report.
  const sized = poolUrl(databaseUrl, undefined, settings.connectionLimit);
  if (!sized) return sized;

  let url: URL;
  try {
    url = new URL(sized);
  } catch {
    return sized;
  }

  let changed = false;
  if (settings.poolTimeoutS !== undefined && !url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", String(settings.poolTimeoutS));
    changed = true;
  }

  const behindPgBouncer = url.searchParams.get("pgbouncer") === "true";
  if (settings.statementTimeoutMs !== undefined && !behindPgBouncer) {
    const options = url.searchParams.get("options") ?? "";
    if (!/statement_timeout/.test(options)) {
      url.searchParams.set("options", `${options} -c statement_timeout=${settings.statementTimeoutMs}`.trim());
      changed = true;
    }
  }

  // Untouched when there was nothing more to add, so the string Prisma sees is the one on
  // the Railway variable, byte for byte, rather than a re-encoding of it.
  return changed ? url.toString() : sized;
}

/**
 * The connection string with an explicit pool size.
 *
 * An override already present in the URL wins: whoever set `connection_limit` on the
 * Railway variable meant it, and a default silently replacing it would make the
 * dashboard lie about what the process is doing.
 *
 * A malformed `DATABASE_POOL_SIZE` falls back to the default rather than throwing.
 * Refusing to boot over a typo in a tuning knob trades a slow page for an outage.
 */
export function poolUrl(
  databaseUrl: string | undefined,
  override?: string,
  fallback: number = DEFAULT_POOL_SIZE,
): string | undefined {
  if (!databaseUrl) return databaseUrl;

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Not a URL we can edit. Hand it back untouched and let Prisma report it — this
    // helper is not the right place to decide a connection string is invalid.
    return databaseUrl;
  }

  if (url.searchParams.has("connection_limit")) return databaseUrl;

  const asked = Number(override);
  const limit = Number.isInteger(asked) && asked > 0 ? asked : fallback;
  url.searchParams.set("connection_limit", String(limit));

  return url.toString();
}
