/**
 * The campaigns index: searching, filtering and paging one shop's campaigns.
 *
 * Pulled out of the route because the same set now feeds two views. A merchant who
 * filters to "needs attention" in the list and switches to the calendar is asking to see
 * those campaigns on a calendar, not to start again — so the filter has to be something
 * both views read, which means it cannot live inside either one.
 */

import prisma from "../../db.server";
import {
  describeState,
  needsAttention,
  type CampaignState,
} from "../../lib/lifecycle/transitions";

export const PAGE_SIZE = 25;

export interface CampaignFilters {
  /** Matches the campaign name. */
  q: string;
  /** A single lifecycle state, or "" for all, or "attention" for the ones needing one. */
  status: string;
  page: number;
}

export function filtersFrom(params: URLSearchParams): CampaignFilters {
  return {
    q: (params.get("q") ?? "").trim(),
    status: (params.get("status") ?? "").trim(),
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
  };
}

/** Turns the filters into a Prisma where clause, minus the parts SQL cannot express. */
function whereFor(shopId: string, filters: CampaignFilters) {
  return {
    shopId,
    ...(filters.q ? { name: { contains: filters.q, mode: "insensitive" as const } } : {}),
    // "attention" is not a status — it is a property of several of them, so it is
    // expanded here rather than being a magic string the database has to understand.
    ...(filters.status === "attention"
      ? { status: { in: ATTENTION_STATES } }
      : filters.status
        ? { status: filters.status as CampaignState }
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
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    prisma.campaign.count({ where }),
    // Counted across the whole shop, not the filtered page. A merchant who has filtered
    // to DRAFT still needs to know something else needs a decision -- hiding it because
    // of an unrelated filter is how a partial run goes unnoticed.
    prisma.campaign.count({ where: { shopId, status: { in: ATTENTION_STATES } } }),
  ]);

  const rows = campaigns.map((c) => {
    const state = c.status as CampaignState;
    return {
      id: c.id,
      name: c.name,
      state,
      lifecycle: describeState(state),
      attention: needsAttention(state),
      priority: c.priority,
      createdAt: c.createdAt.toISOString(),
      lastRun: c.runs[0]
        ? {
            kind: c.runs[0].kind,
            status: c.runs[0].status,
            verified: c.runs[0].verifiedRows,
            failed: c.runs[0].failedRows,
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
