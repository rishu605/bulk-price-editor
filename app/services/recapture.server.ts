/**
 * Scoped recapture, with the checks the operation deserves.
 *
 * Recapture is the most destructive thing this app does. It replaces every baseline in
 * scope with today's live price, and a baseline is what every campaign computes from
 * forever after. Run it during a sale and the sale prices become the merchant's normal
 * prices — permanently.
 *
 * The dashboard used to offer this as a button with a paragraph of warning next to it.
 * That is not enough: the warning is generic, the scope is the whole store, and one
 * click does it. This scopes it, works out which running campaigns it would enshrine,
 * demands a typed confirmation when any do, and writes the whole thing to the audit log
 * with who asked for it.
 */

import prisma from "../db.server";
import { AppError } from "../lib/errors/app-error";
import {
  assessRecapture,
  confirmationMatches,
  type ActiveOverlap,
  type RecaptureAssessment,
} from "../lib/baselines/recapture";
import { captureBaselines } from "./baselines.server";
import { astToWhere, type FilterAst } from "./segments.server";
import { scopeOf } from "./campaigns/model.server";

export interface RecaptureScope {
  /** A saved segment, or the whole catalogue when absent. */
  segmentId?: string;
}

/**
 * Works out what a recapture would do, without doing any of it.
 *
 * The same resolution the recapture itself uses, so the number the merchant confirms is
 * the number that gets rewritten.
 */
export async function planRecapture(
  shopId: string,
  scope: RecaptureScope = {},
): Promise<RecaptureAssessment & { variantGids: string[] }> {
  const variantGids = await resolveScope(shopId, scope);
  const overlaps = await activeOverlaps(shopId, variantGids);

  return { ...assessRecapture(variantGids.length, overlaps), variantGids };
}

export interface RecaptureOptions extends RecaptureScope {
  /** What the merchant typed. Checked against the phrase the assessment demanded. */
  confirmation?: string;
  actor?: string;
}

export async function recapture(shopId: string, options: RecaptureOptions = {}) {
  const plan = await planRecapture(shopId, options);

  if (!confirmationMatches(options.confirmation ?? "", plan.confirmationPhrase)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        `${plan.warning ?? ""} Type “${plan.confirmationPhrase}” to confirm you want to do this anyway.`.trim(),
      context: { shopId, scope: plan.scope, overlaps: plan.overlaps.map((o) => o.campaignId) },
    });
  }

  if (plan.scope === 0) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        "That scope matches no variants, so there is nothing to recapture. Check the segment you picked.",
    });
  }

  const result = await captureBaselines(shopId, {
    variantGids: plan.variantGids,
    // The flag that makes this a recapture rather than a no-op. `captureBaselines`
    // leaves existing baselines alone by default — it runs after every sync, and
    // silently re-anchoring to live prices each time would destroy the whole
    // guarantee. Replacing them is the entire point here, which is why everything
    // above this line exists.
    recapture: true,
    source: "RECAPTURE",
    capturedBy: options.actor,
  });

  // Written whatever the outcome, and written with the overlaps. Six weeks later the
  // question is not "did somebody recapture" but "did somebody recapture over a live
  // sale", and only this row can answer it.
  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: options.actor ?? null,
      action: "baselines.recapture",
      entity: "Shop",
      entityId: shopId,
      after: {
        scope: plan.scope,
        segmentId: options.segmentId ?? null,
        captured: result.captured,
        superseded: result.superseded,
        alreadyCurrent: result.alreadyCurrent,
        overActiveCampaigns: plan.overlaps.map((o) => ({ id: o.campaignId, variants: o.variants })),
      },
    },
  });

  return { ...result, scope: plan.scope, overlaps: plan.overlaps };
}

async function resolveScope(shopId: string, scope: RecaptureScope): Promise<string[]> {
  if (!scope.segmentId) {
    const all = await prisma.variantIndex.findMany({
      where: { shopId, deletedAt: null },
      select: { variantGid: true },
    });
    return all.map((row) => row.variantGid);
  }

  const segment = await prisma.segment.findFirst({
    where: { id: scope.segmentId, shopId },
    select: { kind: true, filterAst: true, frozenVariantGids: true },
  });
  if (!segment) {
    throw new AppError({
      code: "NOT_FOUND",
      userMessage: "That segment no longer exists. Pick another, or recapture the whole catalogue.",
    });
  }

  if (segment.kind === "FROZEN") return segment.frozenVariantGids;

  const rows = await prisma.variantIndex.findMany({
    where: astToWhere(shopId, astOf(segment.filterAst)),
    select: { variantGid: true },
  });
  return rows.map((row) => row.variantGid);
}

/**
 * Which running campaigns are currently pricing variants in the scope.
 *
 * Counted per campaign rather than as a total, because the merchant's decision is
 * usually "revert that one first" and that needs a name attached to a number.
 */
/** Prisma hands back JSON; the AST shape has to be asserted through `unknown`. */
function astOf(stored: unknown): FilterAst {
  const ast = stored as FilterAst | null;
  return ast && Array.isArray(ast.groups) ? ast : { groups: [] };
}

async function activeOverlaps(shopId: string, variantGids: string[]): Promise<ActiveOverlap[]> {
  if (variantGids.length === 0) return [];

  const campaigns = await prisma.campaign.findMany({
    where: { shopId, status: { in: ["ACTIVE", "APPLYING", "PARTIAL"] } },
    select: { id: true, name: true, schedule: true },
  });

  const inScope = new Set(variantGids);
  const overlaps: ActiveOverlap[] = [];

  for (const campaign of campaigns) {
    // The campaign's real scope, resolved the same way a run resolves it — so a
    // segment-targeted campaign is counted against its segment rather than against an
    // empty inline filter, which would match the whole catalogue.
    const ast = await scopeOf(shopId, campaign);
    const covered = await prisma.variantIndex.findMany({
      where: astToWhere(shopId, ast),
      select: { variantGid: true },
    });

    const variants = covered.filter((row) => inScope.has(row.variantGid)).length;
    overlaps.push({ campaignId: campaign.id, campaignName: campaign.name, variants });
  }

  return overlaps;
}
