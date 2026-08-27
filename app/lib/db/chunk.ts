/**
 * Splitting `IN` lists so a query cannot outgrow Postgres.
 *
 * A prepared statement may carry at most 32,767 bind variables, and every element of
 * an `IN (...)` list is one. A campaign scoped to 62,535 variants therefore could not
 * be planned at all: `loadCandidates` asked for its baselines in one statement and
 * Postgres refused the whole query with `P2035`, before a single price was written.
 *
 * Prisma does chunk long `IN` lists on its own, which is why this went unnoticed --
 * but it chunks at exactly 32,767 elements and then adds the where clause's *other*
 * binds on top, so the statement it sends is over the limit by however many other
 * columns the query filters on. The observed failure was `received 32769`: the chunk,
 * plus `shopId` and `surfaceKind`.
 *
 * So the chunk size here is deliberately far below the ceiling rather than just under
 * it. The gap is not tuning slack -- it is room for a caller to add another filter to
 * a query years from now without silently reintroducing this.
 */

/** Postgres's hard limit on bind variables in one prepared statement. */
export const BIND_VARIABLE_CEILING = 32_767;

/**
 * Elements per `IN` list.
 *
 * Small enough that no realistic where clause can reach the ceiling, large enough
 * that a 100,000-variant catalogue is twenty round trips rather than four hundred.
 */
export const IN_CHUNK = 5_000;

/** Splits `items` into consecutive batches of at most `size`. */
export function chunk<T>(items: readonly T[], size: number = IN_CHUNK): T[][] {
  if (size < 1) throw new Error(`chunk size must be at least 1, got ${size}`);
  if (items.length <= size) return items.length === 0 ? [] : [[...items]];

  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Runs `query` once per batch and concatenates the rows.
 *
 * Sequential rather than parallel: these run inside campaign planning, where twenty
 * concurrent statements against the same tables would contend with the run that is
 * writing prices at the same moment. Nothing here is latency-critical enough to trade
 * that away.
 */
export async function inChunks<T, R>(
  items: readonly T[],
  query: (batch: T[]) => Promise<R[]>,
  size: number = IN_CHUNK,
): Promise<R[]> {
  const batches = chunk(items, size);
  if (batches.length === 0) return [];
  if (batches.length === 1) return query(batches[0]);

  const rows: R[] = [];
  for (const batch of batches) rows.push(...(await query(batch)));
  return rows;
}

/**
 * Runs `mutate` once per batch, summing whatever count each returns.
 *
 * Separate from `inChunks` because `updateMany` returns a count rather than rows, and
 * flattening counts as if they were rows would quietly report the wrong number.
 */
export async function inChunksCounting<T>(
  items: readonly T[],
  mutate: (batch: T[]) => Promise<{ count: number }>,
  size: number = IN_CHUNK,
): Promise<{ count: number }> {
  let count = 0;
  for (const batch of chunk(items, size)) count += (await mutate(batch)).count;
  return { count };
}
