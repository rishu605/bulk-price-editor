/**
 * Every state-changing action, who did it, and what it changed.
 *
 * The forensic record. The bar is that somebody can answer "why is this product
 * £8.40?" six weeks later without opening a database client — and, just as often,
 * "who turned that guardrail off?"
 *
 * Deliberately unlimited on every tier. Competitors sell 30/60/90-day history as a
 * paid axis; charging a merchant for the ability to find out what an app did to their
 * prices is the wrong trade.
 */

import prisma from "../db.server";
import { dayRange } from "../lib/scheduling/day-range";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import type { ActivityEntry } from "../lib/reporting/activity-csv";

// Re-exported so callers have one import for "the activity log", while the serialiser
// itself stays client-safe -- see lib/reporting/activity-csv for why that matters.
export { activityCsv, type ActivityEntry } from "../lib/reporting/activity-csv";

export interface ActivityFilters {
  actor?: string;
  action?: string;
  /** Inclusive `YYYY-MM-DD` dates, as the filter form supplies them: days in `timeZone`. */
  from?: string;
  to?: string;
  /**
   * The store's zone, which the page shows every time in (#721). Required, so a caller
   * cannot fall back to UTC days without saying so.
   */
  timeZone: string;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  total: number;
  /** Distinct values present in this shop's log, for the filter controls. */
  actors: string[];
  actions: string[];
}

/** Matches the page's own page size; see the note there for why it is small. */
const PAGE_SIZE = ROWS_PER_VIEW;

export async function activity(
  shopId: string,
  filters: ActivityFilters,
  page = 1,
  /** Rows a page. The screen's by default; an export reads all of them in larger pages (#819). */
  pageSize = PAGE_SIZE,
): Promise<ActivityPage> {
  const where = buildWhere(shopId, filters);

  const [rows, total, actors, actions] = await Promise.all([
    prisma.auditLogEntry.findMany({
      where,
      // `id` breaks ties, so a page boundary between two entries written in the same
      // millisecond neither repeats nor skips one (#819, #769).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (Math.max(1, page) - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLogEntry.count({ where }),
    // Distinct over the whole shop, not the filtered set: a filter control that only
    // offers values matching the current filter cannot be used to change it.
    prisma.auditLogEntry.findMany({
      where: { shopId, actor: { not: null } },
      distinct: ["actor"],
      select: { actor: true },
      take: 50,
    }),
    prisma.auditLogEntry.findMany({
      where: { shopId },
      distinct: ["action"],
      select: { action: true },
      take: 100,
    }),
  ]);

  return {
    entries: rows.map(toEntry),
    total,
    actors: actors.map((a) => a.actor!).filter(Boolean).sort(),
    actions: actions.map((a) => a.action).sort(),
  };
}

/** The whole filtered log, for export. Capped so one click cannot exhaust memory. */
export async function activityForExport(
  shopId: string,
  filters: ActivityFilters,
  limit = 10_000,
): Promise<ActivityEntry[]> {
  const rows = await prisma.auditLogEntry.findMany({
    where: buildWhere(shopId, filters),
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toEntry);
}

function buildWhere(shopId: string, filters: ActivityFilters) {
  const where: Record<string, unknown> = { shopId };

  if (filters.actor) where.actor = filters.actor;
  if (filters.action) where.action = filters.action;

  // Days in the store's zone, the one every time on the page is shown in (#721). The whole
  // of the end day, not midnight at the start of it: a merchant filtering "to today" and
  // seeing nothing from today would reasonably conclude the log is broken.
  const range = dayRange(filters.from, filters.to, filters.timeZone);
  if (range.gte || range.lt) where.createdAt = range;

  return where;
}

type Row = Awaited<ReturnType<typeof prisma.auditLogEntry.findMany>>[number];

function toEntry(row: Row): ActivityEntry {
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    actor: row.actor,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    summary: summarise(row.action, row.before, row.after),
  };
}

/**
 * One readable line for a row.
 *
 * Built from the stored before/after rather than a message written at the time, so
 * entries recorded before a summary existed still read as something. Field-level
 * differences are shown for edits, because "settings updated" answers none of the
 * questions anybody opens this page with.
 */
export function summarise(action: string, before: unknown, after: unknown): string {
  const from = asRecord(before);
  const to = asRecord(after);

  if (from && to) {
    const changed = Object.keys({ ...from, ...to }).filter(
      (key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]),
    );
    if (changed.length > 0) {
      return changed
        .slice(0, 6)
        .map((key) => `${key}: ${render(from[key])} → ${render(to[key])}`)
        .join(", ");
    }
    return "no fields changed";
  }

  const only = to ?? from;
  if (only) {
    const parts = Object.entries(only)
      .slice(0, 6)
      .map(([key, value]) => `${key}: ${render(value)}`);
    if (parts.length > 0) return parts.join(", ");
  }

  return action;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (Array.isArray(value)) return value.length === 0 ? "none" : `${value.length} item(s)`;
  if (typeof value === "object") return JSON.stringify(value).slice(0, 60);
  return String(value);
}
