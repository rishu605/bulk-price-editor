/**
 * The connection budget, checked against the database at boot and logged (#810).
 *
 * Every process adds up every pool -- web × replicas, worker, the reserve -- and compares
 * the sum with what this database role can open. Each process does it, rather than one,
 * because either can be deployed alone and each has only its own environment to go on.
 *
 * Logged, not enforced. Over budget is an error line naming the sum, the limit and the
 * variable to change; it does not stop the process. A pool sized past `max_connections`
 * costs refused connections at peak, and a boot refused over it costs every merchant the
 * app on a deploy -- an outage to prevent a slowdown, which is the trade `poolUrl` already
 * declines for a typo in the same knobs. `max_connections` is also the one number here not
 * in this repo: it changes with the Railway plan, under a deploy that did not change.
 *
 * It also reads back what the session actually got. A statement timeout asked for and not
 * applied -- PgBouncer dropping the startup option, a role setting nobody made -- is said
 * here, once, rather than discovered when a page fails to fail fast.
 */

import type { PrismaClient } from "@prisma/client";

import { logger } from "../logging/logger";
import { judgeBudget, poolBudget, type BudgetVerdict, type PoolEnv, type PoolSettings, type ServerLimits } from "./pool";

type Client = Pick<PrismaClient, "$queryRaw">;

/** What the boot check read from the database. */
export interface DatabaseSettings extends ServerLimits {
  /** The session's `statement_timeout`, in milliseconds; 0 is none. */
  statementTimeoutMs: number;
}

/**
 * `pg_settings` rather than `SHOW`: `reserved_connections` exists only from Postgres 16,
 * and `SHOW` of a missing setting is an error where a missing row is just absent.
 */
export async function readDatabaseSettings(client: Client): Promise<DatabaseSettings> {
  const rows = await client.$queryRaw<Array<{ name: string; setting: string; unit: string | null }>>`
    SELECT name, setting, unit FROM pg_settings
    WHERE name IN ('max_connections', 'superuser_reserved_connections', 'reserved_connections', 'statement_timeout')`;
  const value = (name: string) => Number(rows.find((row) => row.name === name)?.setting ?? 0);
  return {
    maxConnections: value("max_connections"),
    reserved: value("superuser_reserved_connections") + value("reserved_connections"),
    // `statement_timeout`'s unit in pg_settings is ms.
    statementTimeoutMs: value("statement_timeout"),
  };
}

export interface BudgetReport {
  verdict: BudgetVerdict;
  database: DatabaseSettings;
  /** Each thing worth saying beyond the sum, already logged. */
  warnings: string[];
}

/** What else the boot check is told by the process it runs in. */
export interface BudgetContext {
  behindPgBouncer: boolean;
  env?: PoolEnv;
  /**
   * The worker's jobs that can be running at once: every queue's concurrency, plus the
   * scheduler's tick, which runs due campaigns itself. Each holds a connection while it
   * queries, so a pool smaller than this is one a run's writes can queue for -- behind
   * ten products-webhook drains (#811) and five plans as easily as behind a page.
   */
  concurrentJobs?: { total: number; detail: string };
}

/**
 * The check itself, given what the database said: pure, so the arithmetic and every
 * sentence can be tested without one.
 */
export function assessBudget(pool: PoolSettings, database: DatabaseSettings, options: BudgetContext): BudgetReport {
  const verdict = judgeBudget(poolBudget(options.env), database);
  const warnings: string[] = [];

  if (pool.statementTimeoutMs !== undefined && database.statementTimeoutMs !== pool.statementTimeoutMs) {
    warnings.push(
      `DATABASE_STATEMENT_TIMEOUT_WEB_MS asks for ${pool.statementTimeoutMs} ms, but this session's statement_timeout is ` +
        `${database.statementTimeoutMs} ms` +
        (options.behindPgBouncer
          ? ": behind PgBouncer the startup option is not sent, so set it on the web service's database role " +
            `(ALTER ROLE … SET statement_timeout = '${pool.statementTimeoutMs}ms').`
          : "."),
    );
  }
  // A warning rather than an error: most jobs spend most of their time waiting on Shopify
  // with no connection held, and a run waits out a P2024 by retrying (#810). But when the
  // drains and plans are all busy at once, this is the number that decides who waits.
  const jobs = options.concurrentJobs;
  if (pool.role === "worker" && jobs && pool.connectionLimit < jobs.total) {
    warnings.push(
      `The worker's pool of ${pool.connectionLimit} is smaller than the ${jobs.total} jobs it can run at once ` +
        `(${jobs.detail}): with its queues busy, a run's writes wait behind webhook drains and plans for a ` +
        `connection. Raise DATABASE_POOL_SIZE_WORKER to ${jobs.total} if the budget allows.`,
    );
  }

  // The other direction: a timeout on the role or the database that the worker inherits. A
  // run's statements are writes it then cannot finish, so this is louder than the one above.
  if (pool.role === "worker" && database.statementTimeoutMs > 0) {
    warnings.push(
      `The worker's session has a statement_timeout of ${database.statementTimeoutMs} ms, set on its database role or ` +
        "the database rather than by this app. A run's writes can be cancelled by it: give the worker a role without one.",
    );
  }

  return { verdict, database, warnings };
}

/**
 * Reads the database, judges the budget, and logs both. Never throws: a boot check that
 * could stop a boot is the outage the note above declines.
 */
export async function reportPoolBudget(
  client: Client,
  pool: PoolSettings,
  context: Omit<BudgetContext, "behindPgBouncer"> = {},
): Promise<BudgetReport | null> {
  try {
    const database = await readDatabaseSettings(client);
    const behindPgBouncer = /[?&]pgbouncer=true\b/.test(process.env.DATABASE_URL ?? "");
    const report = assessBudget(pool, database, { ...context, behindPgBouncer });
    const fields = {
      process: pool.role,
      connectionLimit: pool.connectionLimit,
      poolTimeoutS: pool.poolTimeoutS ?? null,
      statementTimeoutMs: pool.statementTimeoutMs ?? null,
      sessionStatementTimeoutMs: database.statementTimeoutMs,
      maxConnections: database.maxConnections,
      available: report.verdict.available,
      headroom: report.verdict.headroom,
      pgbouncer: behindPgBouncer,
      concurrentJobs: context.concurrentJobs?.total ?? null,
    };

    if (report.verdict.fits) {
      logger.info(`database pool budget: ${report.verdict.summary}`, fields);
    } else if (behindPgBouncer) {
      // PgBouncer multiplexes these pools onto its own, so the sum may legitimately exceed
      // Postgres's limit: what has to fit then is PgBouncer's pool size. Still said.
      logger.warn(`database pool budget, behind PgBouncer: ${report.verdict.summary}`, fields);
    } else {
      logger.error(`database pool budget exceeded: ${report.verdict.summary}`, fields);
    }
    for (const warning of report.warnings) logger.warn(warning, fields);

    return report;
  } catch (error) {
    logger.warn("database pool budget could not be checked", {
      process: pool.role,
      code: (error as { code?: string })?.code,
    });
    return null;
  }
}
