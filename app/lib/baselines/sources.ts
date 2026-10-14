/**
 * Where a baseline can have come from, as the database names it.
 *
 * Here rather than beside the baselines browser because the page's URL is read against it
 * too, and that parser is shared with the export route and must not import a server
 * module. `satisfies` holds the list to the schema: a name here that the `BaselineSource`
 * enum does not have would be a filter that crashes the query it was meant to narrow.
 */

import type { BaselineSource } from "@prisma/client";

export const BASELINE_SOURCES = [
  "INSTALL_CAPTURE",
  "RECAPTURE",
  "CSV_IMPORT",
  "DRIFT_ADOPTION",
  "AUTO_ENROLL",
] as const satisfies readonly BaselineSource[];

export type BaselineSourceName = (typeof BASELINE_SOURCES)[number];

/**
 * The "Where the baseline came from" filter, read against the sources that exist (#747).
 *
 * It used to reach Prisma as typed, and `source` is an enum column: `?source=hacked` threw
 * inside the query and the page reported that Shopify had rejected a change. Case is
 * ignored, as on the campaigns list; anything that is still not a source is no filter,
 * because the honest answer to a link naming nothing is every baseline, not an error.
 */
export function baselineSourceFrom(raw: string | null): BaselineSourceName | undefined {
  const value = (raw ?? "").trim().toUpperCase();
  return (BASELINE_SOURCES as readonly string[]).includes(value)
    ? (value as BaselineSourceName)
    : undefined;
}
