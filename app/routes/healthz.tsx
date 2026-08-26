/**
 * The liveness endpoint the platform polls.
 *
 * Railway holds a deploy at "deploying" until this answers, then routes traffic to it —
 * so it decides whether a broken release replaces a working one. That makes what it
 * checks a real decision rather than a formality.
 *
 * **It checks the datastores, not just the process.** A web process that is listening but
 * cannot reach Postgres serves every merchant an error page, and a healthcheck that only
 * proved the port was open would happily promote it over the release that worked. Both
 * checks are cheap — a `SELECT 1` and a Redis `PING` — and they are the two dependencies
 * whose absence makes the app useless rather than degraded.
 *
 * **Redis missing is degraded, not dead.** The queue falls back to running jobs inline, so
 * a shop can still preview and apply; scheduling is what suffers. That is reported in the
 * body and deliberately does not fail the check, because taking the web service down for
 * it would turn a partial outage into a total one.
 *
 * Unauthenticated on purpose: it is called by the platform before any session exists, and
 * it returns no shop data — only whether two dependencies answered.
 */

import prisma from "../db.server";

interface Check {
  ok: boolean;
  detail?: string;
}

async function checkDatabase(): Promise<Check> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkRedis(): Promise<Check> {
  const url = process.env.REDIS_URL;
  if (!url) return { ok: false, detail: "REDIS_URL is not set" };

  // Imported here rather than at module scope so a web process with no Redis does not
  // pay for the client on every request that is not this one.
  const { default: Redis } = await import("ioredis");
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    lazyConnect: true,
  });

  try {
    await client.connect();
    await client.ping();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    client.disconnect();
  }
}

export async function loader() {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  // Only the database can fail the check. Without it nothing works; without Redis the
  // queue runs inline and campaigns still apply.
  const status = database.ok ? 200 : 503;

  return new Response(
    JSON.stringify({
      status: database.ok ? (redis.ok ? "ok" : "degraded") : "unhealthy",
      database,
      redis,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}
