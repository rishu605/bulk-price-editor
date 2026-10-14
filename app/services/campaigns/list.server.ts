/**
 * The campaigns index: searching, filtering and paging one shop's campaigns.
 *
 * Pulled out of the route because the same set now feeds two views. A merchant who
 * filters to "needs attention" in the list and switches to the calendar is asking to see
 * those campaigns on a calendar, not to start again — so the filter has to be something
 * both views read, which means it cannot live inside either one.
 */

import { neverStarts, parseSchedule } from "../../lib/scheduling/window";
import prisma from "../../db.server";
import { describeCampaign } from "../../lib/campaigns/describe";
import { astOf, ruleOf } from "./model.server";
import { ROWS_PER_VIEW } from "../../lib/ui/table-budget";
import {
  ALL_STATES,
  describeState,
  needsAttention,
  type CampaignState,
} from "../../lib/lifecycle/transitions";

export const PAGE_SIZE = ROWS_PER_VIEW;

/** What the status filter can be: everything, the ones needing a decision, or one state. */
export type StatusFilter = "" | "attention" | CampaignState;

export interface CampaignFilters {
  /** Matches the campaign name. */
  q: string;
  /** A single lifecycle state, or "" for all, or "attention" for the ones needing one. */
  status: StatusFilter;
  /**
   * Whether to show the campaigns that have been filed away.
   *
   * Not a value in `status`, because it is not a lifecycle state — a merchant looking for
   * an archived campaign is usually looking for a *finished* one, and folding the two
   * into one control would mean losing the status filter to use the archive.
   */
  archived: boolean;
  page: number;
}

export function filtersFrom(params: URLSearchParams): CampaignFilters {
  return {
    q: (params.get("q") ?? "").trim(),
    status: statusFrom(params.get("status")),
    archived: params.get("archived") === "1",
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
  };
}

/**
 * The status filter, read against the states that exist rather than trusted (#747).
 *
 * It used to go into the where clause as typed. `status` is an enum column, so anything
 * that was not exactly a member -- `active` from a hand-typed or old link, a typo, a
 * pasted `<script>` -- threw inside Prisma, and the whole list was replaced by an error
 * page for a filter the merchant could simply have not had.
 *
 * Case does not matter, because the states are words a merchant reads on the page and
 * then types in lower case: `active` means ACTIVE, and refusing it would be pedantry about
 * a value whose meaning is not in doubt. Anything that is still not a state is dropped,
 * not refused. A filter link is a convenience, and the honest answer to one that names
 * nothing is the unfiltered list -- with "All" selected, so the page says what it is
 * showing -- rather than an error about a parameter the merchant never chose to send.
 */
export function statusFrom(raw: string | null): StatusFilter {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "ATTENTION") return "attention";
  return (ALL_STATES as readonly string[]).includes(value) ? (value as CampaignState) : "";
}

/** Turns the filters into a Prisma where clause, minus the parts SQL cannot express. */
function whereFor(shopId: string, filters: CampaignFilters) {
  const contains = { contains: filters.q, mode: "insensitive" as const };

  return {
    shopId,
    // Archived is the *filter*, not a second list: one view, one control, and the row
    // still says what state the campaign is in. `null` and "not null" rather than a
    // boolean column, so the archive can be read in the order things were filed.
    archivedAt: filters.archived ? { not: null } : null,
    // The note is searched alongside the name, which is the point of having one: "why did
    // we run this" is not a question a merchant can answer by remembering what they
    // called it. Prisma leaves a null note out of a `contains` match, so a shop with no
    // notes searches exactly as it did before.
    ...(filters.q ? { OR: [{ name: contains }, { note: contains }] } : {}),
    // "attention" is not a status — it is a property of several of them, so it is
    // expanded here rather than being a magic string the database has to understand.
    ...(filters.status === "attention"
      ? { status: { in: ATTENTION_STATES } }
      : filters.status
        ? { status: filters.status }
        : {}),
  };
}

/** The states `needsAttention` is true for, as the database sees them. */
const ATTENTION_STATES: CampaignState[] = ["PARTIAL", "HELD"];

export async function listCampaigns(shopId: string, filters: CampaignFilters) {
  const where = whereFor(shopId, filters);

  const [campaigns, total, attentionCount] = await Promise.all([
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          // Its bulk operation and the rows sent in it, for how far Shopify has got (#832).
          include: {
            bulkOps: {
              where: { kind: "MUTATION" },
              orderBy: { submittedAt: "desc" },
              select: { objectCount: true },
              take: 1,
            },
            _count: { select: { changes: { where: { status: "WRITING" } } } },
          },
        },
        // Named so the row can say what the campaign applies to. A segment replaces the
        // inline filter rather than narrowing it, so where there is one it *is* the
        // scope — see `describeScope`.
        segments: { select: { name: true }, take: 1 },
      },
    }),
    prisma.campaign.count({ where }),
    // Counted across the whole shop, not the filtered page. A merchant who has filtered
    // to DRAFT still needs to know something else needs a decision -- hiding it because
    // of an unrelated filter is how a partial run goes unnoticed.
    // Archived is the one exception. A campaign a merchant has deliberately filed away
    // should not go on demanding a decision from the top of a list it is no longer in —
    // that is a badge counting something the merchant cannot see.
    prisma.campaign.count({
      where: { shopId, status: { in: ATTENTION_STATES }, archivedAt: null },
    }),
  ]);

  const rows = campaigns.map((c) => {
    const state = c.status as CampaignState;
    return {
      id: c.id,
      name: c.name,
      state,
      // A scheduled campaign whose window can never open reads as one (#824). The row
      // shows the label, not the reason, so the zone the reason is written in does not matter.
      lifecycle: describeState(state, {
        neverStarts: state === "SCHEDULED" ? neverStarts(parseSchedule(c.schedule), new Date(), "UTC") : null,
      }),
      attention: needsAttention(state),
      priority: c.priority,
      // What it does and what to, as sentences, through the one formatter every surface
      // uses. The index used to say everything *about* a campaign and nothing about what
      // it is.
      ...describeCampaign({ rule: ruleOf(c), ast: astOf(c), segmentName: c.segments[0]?.name }),
      note: c.note,
      archived: c.archivedAt !== null,
      createdAt: c.createdAt.toISOString(),
      lastRun: c.runs[0]
        ? {
            kind: c.runs[0].kind,
            status: c.runs[0].status,
            verified: c.runs[0].verifiedRows,
            failed: c.runs[0].failedRows,
            // The rows the run sent in a bulk operation and has not read back. Its own counts
            // stay at zero until the results are read, and "0 verified" over an hour of
            // prices going live read as nothing happening (#832). `live` is whether a
            // process is still polling it -- only then is Shopify's count current.
            atShopify:
              c.runs[0].bulkOps[0] && c.runs[0]._count.changes > 0
                ? {
                    done: Number(c.runs[0].bulkOps[0].objectCount ?? 0),
                    of: c.runs[0]._count.changes,
                    live: ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"].includes(c.runs[0].status),
                  }
                : null,
          }
        : null,
    };
  });

  // Anything needing a decision sorts to the top of its page. A partial run buried
  // below a screen of drafts is functionally the same as not reporting it.
  rows.sort((a, b) => Number(b.attention) - Number(a.attention));

  return {
    campaigns: rows,
    total,
    attentionCount,
    page: filters.page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}
