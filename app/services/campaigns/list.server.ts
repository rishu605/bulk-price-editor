/**
 * The campaigns index: searching, filtering and paging one shop's campaigns.
 *
 * Pulled out of the route because the same set now feeds two views. A merchant who
 * filters to "needs attention" in the list and switches to the calendar is asking to see
 * those campaigns on a calendar, not to start again — so the filter has to be something
 * both views read, which means it cannot live inside either one.
 */

import prisma from "../../db.server";
import { describeCampaign } from "../../lib/campaigns/describe";
import { astOf, ruleOf } from "./model.server";
import { ROWS_PER_VIEW } from "../../lib/ui/table-budget";
import {
  describeState,
  needsAttention,
  type CampaignState,
} from "../../lib/lifecycle/transitions";

export const PAGE_SIZE = ROWS_PER_VIEW;

export interface CampaignFilters {
  /** Matches the campaign name. */
  q: string;
  /** A single lifecycle state, or "" for all, or "attention" for the ones needing one. */
  status: string;
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
    status: (params.get("status") ?? "").trim(),
    archived: params.get("archived") === "1",
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
  };
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
      include: {
        runs: { orderBy: { createdAt: "desc" }, take: 1 },
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
      lifecycle: describeState(state),
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
