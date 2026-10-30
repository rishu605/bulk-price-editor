/**
 * The connection budget, checked at boot and said out loud (#810).
 *
 * What is pinned: the sum is judged against what the database reports, an over-budget
 * deploy is an error line naming the variable to change -- and never a refused boot -- and a
 * statement timeout that did not take, or that reaches the worker from its database role,
 * is said once at boot rather than found when a page fails to fail fast.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const lines = vi.hoisted(() => [] as Array<{ level: string; message: string; fields?: Record<string, unknown> }>);
vi.mock("../logging/logger", () => ({
  logger: {
    debug: () => {},
    info: (message: string, fields?: Record<string, unknown>) => lines.push({ level: "info", message, fields }),
    warn: (message: string, fields?: Record<string, unknown>) => lines.push({ level: "warn", message, fields }),
    error: (message: string, fields?: Record<string, unknown>) => lines.push({ level: "error", message, fields }),
  },
}));

import { assessBudget, readDatabaseSettings, reportPoolBudget } from "./budget.server";
import { poolSettings } from "./pool";

/** A client that answers the boot check's one query with these settings. */
function database(settings: Record<string, string>) {
  return {
    $queryRaw: (async () => Object.entries(settings).map(([name, setting]) => ({ name, setting, unit: null }))) as never,
  };
}

const pg16 = { max_connections: "100", superuser_reserved_connections: "3", reserved_connections: "0", statement_timeout: "0" };

beforeEach(() => {
  lines.length = 0;
  vi.unstubAllEnvs();
});

describe("reading the database's limits", () => {
  it("counts every slot this role cannot open", async () => {
    const read = await readDatabaseSettings(database({ ...pg16, reserved_connections: "2" }));

    expect(read).toEqual({ maxConnections: 100, reserved: 5, statementTimeoutMs: 0 });
  });

  it("copes with a Postgres older than reserved_connections", async () => {
    const pg15 = Object.fromEntries(Object.entries(pg16).filter(([name]) => name !== "reserved_connections"));

    expect((await readDatabaseSettings(database(pg15))).reserved).toBe(3);
  });
});

describe("judging the budget", () => {
  it("passes today's deploy against a 100-connection database", () => {
    const report = assessBudget(poolSettings("web", {}), { maxConnections: 100, reserved: 3, statementTimeoutMs: 0 }, { behindPgBouncer: false, env: {} });

    expect(report.verdict.fits).toBe(true);
    expect(report.verdict.headroom).toBe(97 - 25);
    expect(report.warnings).toEqual([]);
  });

  it("says when the web's statement timeout did not take", () => {
    const pool = poolSettings("web", { DATABASE_STATEMENT_TIMEOUT_WEB_MS: "5000" });
    const report = assessBudget(pool, { maxConnections: 100, reserved: 3, statementTimeoutMs: 0 }, { behindPgBouncer: true, env: {} });

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/asks for 5000 ms, but this session's statement_timeout is 0 ms/);
    expect(report.warnings[0]).toMatch(/behind PgBouncer .* set it on the web service's database role/);
  });

  it("is quiet when the web's statement timeout is what was asked for", () => {
    const pool = poolSettings("web", { DATABASE_STATEMENT_TIMEOUT_WEB_MS: "5000" });

    expect(assessBudget(pool, { maxConnections: 100, reserved: 3, statementTimeoutMs: 5000 }, { behindPgBouncer: false, env: {} }).warnings).toEqual([]);
  });

  it("warns when the worker's pool is smaller than the jobs it runs at once", () => {
    // Ten products-webhook drains (#811), five plans and the run itself share this pool. A
    // run waits out a P2024 by retrying, but the boot line should say who it is waiting for.
    const concurrentJobs = { total: 22, detail: "sync 1, webhooks 10, planning 5, execution 2, verification 2, audit 1, scheduler tick 1" };
    const small = assessBudget(poolSettings("worker", {}), { maxConnections: 100, reserved: 3, statementTimeoutMs: 0 }, { behindPgBouncer: false, env: {}, concurrentJobs });
    const enough = assessBudget(poolSettings("worker", { DATABASE_POOL_SIZE_WORKER: "22" }), { maxConnections: 100, reserved: 3, statementTimeoutMs: 0 }, { behindPgBouncer: false, env: {}, concurrentJobs });
    const web = assessBudget(poolSettings("web", {}), { maxConnections: 100, reserved: 3, statementTimeoutMs: 0 }, { behindPgBouncer: false, env: {}, concurrentJobs });

    expect(small.warnings).toEqual([
      "The worker's pool of 10 is smaller than the 22 jobs it can run at once (sync 1, webhooks 10, planning 5, " +
        "execution 2, verification 2, audit 1, scheduler tick 1): with its queues busy, a run's writes wait behind " +
        "webhook drains and plans for a connection. Raise DATABASE_POOL_SIZE_WORKER to 22 if the budget allows.",
    ]);
    expect(enough.warnings).toEqual([]);
    expect(web.warnings, "the web process runs no queue").toEqual([]);
  });

  it("warns when the worker inherits a statement timeout from its role", () => {
    // Not this app's doing -- it never sets one for the worker -- but a run's writes cancelled
    // part-way by it would look exactly like the failures #810 is about.
    const report = assessBudget(poolSettings("worker", {}), { maxConnections: 100, reserved: 3, statementTimeoutMs: 5000 }, { behindPgBouncer: false, env: {} });

    expect(report.warnings[0]).toMatch(/The worker's session has a statement_timeout of 5000 ms/);
  });
});

describe("the boot line", () => {
  it("logs the sum and the limit, once, at info", async () => {
    const report = await reportPoolBudget(database(pg16), poolSettings("worker", {}));

    expect(report?.verdict.fits).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.message).toMatch(/^database pool budget: web 10 \+ worker 10 \+ reserve 5 = 25, within max_connections 100/);
    expect(lines[0]!.fields).toMatchObject({ process: "worker", connectionLimit: 10, maxConnections: 100, headroom: 72 });
  });

  it("logs an error naming what to change when the pools do not fit", async () => {
    vi.stubEnv("DATABASE_POOL_SIZE_WEB", "60");
    vi.stubEnv("DATABASE_POOL_SIZE_WORKER", "40");

    const report = await reportPoolBudget(database(pg16), poolSettings("web"));

    expect(report?.verdict.fits).toBe(false);
    expect(lines[0]!.level).toBe("error");
    expect(lines[0]!.message).toMatch(/^database pool budget exceeded: web 60 \+ worker 40 \+ reserve 5 = 105, over/);
    expect(lines[0]!.message).toMatch(/Lower DATABASE_POOL_SIZE_WEB or DATABASE_POOL_SIZE_WORKER/);
  });

  it("downgrades an over-budget sum to a warning behind PgBouncer, where it can be intended", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://a:b@pooler:6432/db?pgbouncer=true");
    vi.stubEnv("DATABASE_POOL_SIZE_WEB", "60");
    vi.stubEnv("DATABASE_POOL_SIZE_WORKER", "40");

    await reportPoolBudget(database(pg16), poolSettings("web"));

    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.message).toMatch(/behind PgBouncer/);
  });

  it("never throws, and never stops a boot, when the database cannot be asked", async () => {
    const unreachable = { $queryRaw: (async () => { throw Object.assign(new Error("pool"), { code: "P2024" }); }) as never };

    await expect(reportPoolBudget(unreachable, poolSettings("web", {}))).resolves.toBeNull();
    expect(lines).toEqual([{ level: "warn", message: "database pool budget could not be checked", fields: { process: "web", code: "P2024" } }]);
  });
});
