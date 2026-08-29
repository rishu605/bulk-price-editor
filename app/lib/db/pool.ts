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
 * way through writing prices. `MAX_INLINE_ROWS` exists because a request that outlives
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
 */

/** Connections per process, absent an explicit override. */
export const DEFAULT_POOL_SIZE = 10;

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
