/**
 * The pool size is a number this app chose, and says so in the connection string.
 *
 * Prisma's default is `num_physical_cpus * 2 + 1`, read from whichever container the
 * process lands on — so the web service and the worker would each pick their own, and
 * nothing would account for their sum against `max_connections`. Exhaustion then surfaces
 * wherever the next query happened to be, including part way through writing prices.
 *
 * What is worth pinning here is the *precedence*, because every failure mode of this
 * helper is silent: an override that gets replaced makes the Railway dashboard lie about
 * what the process is doing, and a malformed value that throws turns a typo in a tuning
 * knob into a service that will not boot.
 */

import { describe, expect, it } from "vitest";

import {
  connectionUrl,
  DEFAULT_POOL_RESERVE,
  DEFAULT_POOL_SIZE,
  judgeBudget,
  poolBudget,
  poolSettings,
  poolUrl,
  type PoolEnv,
} from "./pool";

const BASE = "postgresql://anchor:anchor@localhost:5432/anchor_dev";

const limitOf = (url: string | undefined): string | null =>
  url ? new URL(url).searchParams.get("connection_limit") : null;

describe("choosing the pool size", () => {
  it("applies the default when nothing asks for anything", () => {
    expect(limitOf(poolUrl(BASE))).toBe(String(DEFAULT_POOL_SIZE));
  });

  it("takes an override from the environment", () => {
    expect(limitOf(poolUrl(BASE, "5"))).toBe("5");
  });

  it("leaves a limit already in the URL alone", () => {
    // Whoever set `connection_limit` on the Railway variable meant it. A default quietly
    // replacing it would make the dashboard describe a process that is not running.
    const explicit = `${BASE}?connection_limit=3`;

    expect(limitOf(poolUrl(explicit, "5"))).toBe("3");
  });

  it.each(["", "  ", "many", "0", "-1", "2.5", "NaN"])(
    "falls back to the default for %o rather than refusing to boot",
    (override) => {
      expect(limitOf(poolUrl(BASE, override))).toBe(String(DEFAULT_POOL_SIZE));
    },
  );
});

describe("what it does not damage", () => {
  it("keeps the parameters already on the connection string", () => {
    // Railway's URL carries sslmode. Rebuilding the string without it would silently
    // change how the process connects.
    const withSsl = `${BASE}?sslmode=require&schema=public`;
    const result = new URL(poolUrl(withSsl) ?? "");

    expect(result.searchParams.get("sslmode")).toBe("require");
    expect(result.searchParams.get("schema")).toBe("public");
    expect(result.searchParams.get("connection_limit")).toBe(String(DEFAULT_POOL_SIZE));
  });

  it("keeps credentials, host, port and database", () => {
    const result = new URL(poolUrl(BASE) ?? "");

    expect(result.username).toBe("anchor");
    expect(result.hostname).toBe("localhost");
    expect(result.port).toBe("5432");
    expect(result.pathname).toBe("/anchor_dev");
  });

  it("hands back an unparseable string untouched", () => {
    // Deciding a connection string is invalid is Prisma's job, and its message names the
    // problem. Throwing here would replace that with a stack trace from a tuning helper.
    expect(poolUrl("not a url")).toBe("not a url");
  });

  it("hands back a missing string as missing", () => {
    // So the caller can fall through to `new PrismaClient()` and let Prisma raise the
    // "DATABASE_URL is not set" error it already has good wording for.
    expect(poolUrl(undefined)).toBeUndefined();
  });
});

/**
 * Two pools, sized and timed out apart (#810).
 *
 * #803 measured what one shared shape costs: a 102k-variant run held the pool, `SELECT 1`
 * waited 9–12 s for forty minutes, and the run's own writes failed with P2024. A page wants
 * to fail in a second with a sentence; a run wants to wait. What is pinned here is that
 * each gets its own, that a page's statement timeout can never reach the worker, and that
 * an unset environment changes nothing about how either process connects today.
 */
describe("a pool per process", () => {
  const timeouts: PoolEnv = { DATABASE_STATEMENT_TIMEOUT_WEB_MS: "5000", DATABASE_POOL_TIMEOUT_WEB_S: "2" };

  it("gives both processes today's pool when nothing is set", () => {
    // The deploy that ships this must not change how anything connects until somebody
    // sets a variable: ten connections, Prisma's own pool timeout, no statement timeout.
    expect(poolSettings("web", {})).toEqual({ role: "web", connectionLimit: DEFAULT_POOL_SIZE, poolTimeoutS: undefined, statementTimeoutMs: undefined });
    expect(poolSettings("worker", {})).toEqual({ role: "worker", connectionLimit: DEFAULT_POOL_SIZE });

    const web = new URL(connectionUrl(BASE, poolSettings("web", {}))!);
    expect(web.searchParams.get("connection_limit")).toBe(String(DEFAULT_POOL_SIZE));
    expect(web.searchParams.has("pool_timeout")).toBe(false);
    expect(web.searchParams.has("options")).toBe(false);
  });

  it("still honours the one shared size, for a deploy that set it before #810", () => {
    expect(poolSettings("web", { DATABASE_POOL_SIZE: "7" }).connectionLimit).toBe(7);
    expect(poolSettings("worker", { DATABASE_POOL_SIZE: "7" }).connectionLimit).toBe(7);
  });

  it("sizes each process from its own variable, over the shared one", () => {
    const env: PoolEnv = { DATABASE_POOL_SIZE: "7", DATABASE_POOL_SIZE_WEB: "15", DATABASE_POOL_SIZE_WORKER: "20" };

    expect(poolSettings("web", env).connectionLimit).toBe(15);
    expect(poolSettings("worker", env).connectionLimit).toBe(20);
  });

  it.each(["", "many", "0", "-3", "1.5"])("falls back for a size of %o rather than refusing to boot", (bad) => {
    expect(poolSettings("worker", { DATABASE_POOL_SIZE_WORKER: bad }).connectionLimit).toBe(DEFAULT_POOL_SIZE);
  });

  it("puts the statement and pool timeouts on the web's connection", () => {
    const url = new URL(connectionUrl(BASE, poolSettings("web", timeouts))!);

    expect(url.searchParams.get("options")).toBe("-c statement_timeout=5000");
    expect(url.searchParams.get("pool_timeout")).toBe("2");
  });

  it("never puts the web's statement timeout on the worker", () => {
    // A run's writes under a page's five-second limit would be cancelled part-way, on the
    // largest statements a run makes, at exactly the moment the database is busiest.
    const worker = poolSettings("worker", timeouts);
    expect(worker.statementTimeoutMs).toBeUndefined();
    expect(worker.poolTimeoutS).toBeUndefined();

    const url = new URL(connectionUrl(BASE, worker)!);
    expect(url.searchParams.has("options")).toBe(false);
    expect(url.searchParams.has("pool_timeout")).toBe(false);
  });

  it("refuses a fractional pool timeout, as Prisma would", () => {
    // Prisma rejects `pool_timeout=0.5` as a malformed connection string, which would be a
    // web service that cannot connect at all over a tuning knob.
    expect(poolSettings("web", { DATABASE_POOL_TIMEOUT_WEB_S: "0.5" }).poolTimeoutS).toBeUndefined();
  });

  it("leaves a timeout already on the URL alone, as it does a size", () => {
    const explicit = `${BASE}?pool_timeout=30&options=-c%20statement_timeout%3D9000`;
    const url = new URL(connectionUrl(explicit, poolSettings("web", timeouts))!);

    expect(url.searchParams.get("pool_timeout")).toBe("30");
    expect(url.searchParams.get("options")).toBe("-c statement_timeout=9000");
  });

  it("adds to other startup options rather than replacing them", () => {
    const url = new URL(connectionUrl(`${BASE}?options=-c%20search_path%3Dpublic`, poolSettings("web", timeouts))!);

    expect(url.searchParams.get("options")).toBe("-c search_path=public -c statement_timeout=5000");
  });

  it("sends no startup option through PgBouncer, which would refuse or drop it", () => {
    // Behind transaction pooling the timeout belongs on the web's database role; the boot
    // check reads the session back and says so when it is missing.
    const url = new URL(connectionUrl(`${BASE}?pgbouncer=true`, poolSettings("web", timeouts))!);

    expect(url.searchParams.get("pgbouncer")).toBe("true");
    expect(url.searchParams.has("options")).toBe(false);
    expect(url.searchParams.get("pool_timeout")).toBe("2");
  });

  it("hands back the exact string when there is nothing to add", () => {
    const explicit = `${BASE}?connection_limit=3&sslmode=require`;

    expect(connectionUrl(explicit, poolSettings("worker", {}))).toBe(explicit);
    expect(connectionUrl("not a url", poolSettings("web", timeouts))).toBe("not a url");
    expect(connectionUrl(undefined, poolSettings("web", timeouts))).toBeUndefined();
  });
});

describe("the connection budget (#810)", () => {
  const limits = { maxConnections: 100, reserved: 3 };

  it("adds up today's deploy: two pools of ten and the reserve", () => {
    expect(poolBudget({})).toEqual({ web: 10, webReplicas: 1, worker: 10, reserve: DEFAULT_POOL_RESERVE, total: 25 });
  });

  it("counts a full web pool per replica", () => {
    const budget = poolBudget({ DATABASE_POOL_SIZE_WEB: "15", DATABASE_POOL_SIZE_WORKER: "20", WEB_REPLICAS: "3" });

    expect(budget.total).toBe(15 * 3 + 20 + DEFAULT_POOL_RESERVE);
  });

  it("takes a reserve of zero as an answer, not a typo", () => {
    expect(poolBudget({ DATABASE_POOL_RESERVE: "0" }).reserve).toBe(0);
    expect(poolBudget({ DATABASE_POOL_RESERVE: "lots" }).reserve).toBe(DEFAULT_POOL_RESERVE);
  });

  it("fits #810's example under a 100-connection Postgres, with what is spare", () => {
    const verdict = judgeBudget(poolBudget({ DATABASE_POOL_SIZE_WEB: "15", DATABASE_POOL_SIZE_WORKER: "20" }), limits);

    expect(verdict.fits).toBe(true);
    expect(verdict.available).toBe(97);
    expect(verdict.headroom).toBe(97 - 40);
    expect(verdict.summary).toBe(
      "web 15 + worker 20 + reserve 5 = 40, within max_connections 100 − 3 reserved for superusers = 97 (57 spare)",
    );
  });

  it("does not count the superuser slots as the app's", () => {
    // 98 against 100 looks like it fits, and the last pool to connect is refused: three of
    // those hundred are not this role's to open.
    const verdict = judgeBudget(poolBudget({ DATABASE_POOL_SIZE_WEB: "45", DATABASE_POOL_SIZE_WORKER: "48" }), limits);

    expect(verdict.fits).toBe(false);
    expect(verdict.headroom).toBe(-1);
  });

  it("says what is over, by how much, and what to change", () => {
    const verdict = judgeBudget(poolBudget({ DATABASE_POOL_SIZE_WEB: "40", WEB_REPLICAS: "2", DATABASE_POOL_SIZE_WORKER: "30" }), limits);

    expect(verdict.summary).toMatch(/^web 40 × 2 replicas \+ worker 30 \+ reserve 5 = 115, over max_connections 100/);
    expect(verdict.summary).toMatch(/by 18\./);
    expect(verdict.summary).toMatch(/Lower DATABASE_POOL_SIZE_WEB or DATABASE_POOL_SIZE_WORKER/);
  });
});
