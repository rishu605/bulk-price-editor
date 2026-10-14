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
import { asAuditMoney, auditMoney, describeAuditMoney } from "../lib/audit/money";
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
    entries: await toEntries(shopId, rows),
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
  return toEntries(shopId, rows);
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

/**
 * Rows as the page and the export show them, with what the summary needs looked up once.
 *
 * Two lookups, each one query however many rows there are: the titles of the variants the
 * entries are about (#757), and the currency of any drift entry written before prices
 * carried theirs.
 */
async function toEntries(shopId: string, rows: readonly Row[]): Promise<ActivityEntry[]> {
  const variantGids = [...new Set(rows.map(variantOf).filter((gid): gid is string => gid !== null))];
  const legacyDrift = rows.filter((row) => legacyDriftPrice(row) !== null).map((row) => row.entityId!);

  const [variants, events] = await Promise.all([
    variantGids.length === 0
      ? []
      : prisma.variantIndex.findMany({
          where: { shopId, variantGid: { in: variantGids } },
          select: { variantGid: true, title: true },
        }),
    legacyDrift.length === 0
      ? []
      : prisma.driftEvent.findMany({
          where: { shopId, id: { in: legacyDrift } },
          select: { id: true, currency: true },
        }),
  ]);

  const titles = new Map(
    variants.flatMap((variant) => (variant.title ? [[variant.variantGid, variant.title] as const] : [])),
  );
  const currencyOf = new Map(events.map((event) => [event.id, event.currency]));

  return rows.map((row) => {
    const legacy = legacyDriftPrice(row);
    const currency = row.entityId ? currencyOf.get(row.entityId) : undefined;
    const after =
      legacy !== null && currency
        ? { ...asRecord(row.after), observedPrice: auditMoney(BigInt(legacy), currency) }
        : row.after;

    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      actor: row.actor,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      variantGid: variantOf(row),
      summary: summarise(row.action, row.before, after, { titles }),
    };
  });
}

/** The variant an entry is about, when it is about exactly one. */
function variantOf(row: Pick<Row, "before" | "after">): string | null {
  const gid = asRecord(row.after)?.[VARIANT] ?? asRecord(row.before)?.[VARIANT];
  return typeof gid === "string" && gid !== "" ? gid : null;
}

/**
 * The bare minor units a drift entry recorded before #757, or null.
 *
 * Until then resolving a drift wrote `observedPrice: String(event.observedPrice)` -- the
 * event's integer minor units with no currency. The number alone cannot be shown: 70100 is
 * $701.00 or ¥70,100. But each such entry names its `DriftEvent`, the event carries the
 * currency the price was observed in, and events are never deleted, so the currency is
 * recovered from the record the price came from rather than guessed from the shop. Only
 * these entries: no other writer stored a bare price, and widening this to any field that
 * looks like one is the guess `lib/audit/money` rejects.
 */
function legacyDriftPrice(row: Pick<Row, "action" | "entity" | "entityId" | "after">): string | null {
  if (row.entity !== "DriftEvent" || !row.entityId || !row.action.startsWith("drift.")) return null;
  const observed = asRecord(row.after)?.observedPrice;
  return typeof observed === "string" && /^-?\d+$/.test(observed) ? observed : null;
}

export interface SummaryContext {
  /** Variant titles by GID, from the catalogue mirror. A GID missing here is shown as itself. */
  titles?: ReadonlyMap<string, string>;
}

/** The key an entry names its one variant by. Shown by title, as "variant" (#757). */
const VARIANT = "variantGid";

/**
 * One readable line for a row.
 *
 * Built from the stored before/after rather than a message written at the time, so
 * entries recorded before a summary existed still read as something. Field-level
 * differences are shown for edits, because "settings updated" answers none of the
 * questions anybody opens this page with.
 */
export function summarise(
  action: string,
  before: unknown,
  after: unknown,
  context: SummaryContext = {},
): string {
  const from = asRecord(before);
  const to = asRecord(after);

  // A variant is named by its title: "gid://shopify/ProductVariant/45725717004522" is not
  // something a merchant can find in their admin. The GID stays in the export, in its own
  // column, for whoever has to join this to something else.
  const label = (key: string) => (key === VARIANT ? "variant" : key);
  const show = (key: string, value: unknown) =>
    render(key === VARIANT && typeof value === "string" ? (context.titles?.get(value) ?? value) : value);

  if (from && to) {
    const changed = Object.keys({ ...from, ...to }).filter(
      (key) => JSON.stringify(from[key]) !== JSON.stringify(to[key]),
    );
    if (changed.length > 0) {
      return changed
        .slice(0, 6)
        .map((key) => `${label(key)}: ${show(key, from[key])} → ${show(key, to[key])}`)
        .join(", ");
    }
    return "no fields changed";
  }

  const only = to ?? from;
  if (only) {
    const parts = Object.entries(only)
      .slice(0, 6)
      .map(([key, value]) => `${label(key)}: ${show(key, value)}`);
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
  // A price, written with its currency by the one function that writes them. Recognised
  // by that shape and never by the field's name -- `lib/audit/money` says why.
  const price = asAuditMoney(value);
  if (price) return describeAuditMoney(price);
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (Array.isArray(value)) return value.length === 0 ? "none" : `${value.length} item(s)`;
  if (typeof value === "object") return JSON.stringify(value).slice(0, 60);
  return String(value);
}
