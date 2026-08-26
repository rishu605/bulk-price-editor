/**
 * A two-person rule for campaigns big enough to matter.
 *
 * Aimed at Plus organisations where a pricing change needs sign-off. The point is not the
 * record — the audit log already has that. It is that a campaign above the threshold
 * **physically cannot run** until somebody other than its author says so, enforced in the
 * run path rather than in the interface, because an approval a scheduler can walk past is
 * not an approval.
 *
 * Off by default. Most stores are one person, and requiring them to approve their own work
 * would be a ritual that teaches people to click through warnings — which is worse than
 * no rule at all, because the same reflex is what makes the real warnings ineffective.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { astToWhere } from "./segments.server";
import { scopeOf } from "./campaigns/model.server";
import { readSettings } from "./settings.server";

export interface ApprovalPolicy {
  /** Campaigns changing more than this need a second person. Null means never. */
  threshold: number | null;
}

export function approvalPolicyOf(settings: { approvalThreshold?: unknown }): ApprovalPolicy {
  const raw = settings.approvalThreshold;
  const parsed = typeof raw === "number" ? raw : Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? { threshold: Math.floor(parsed) } : { threshold: null };
}

export type ApprovalState =
  | { required: false }
  | { required: true; state: "none" }
  | { required: true; state: "pending"; requestedBy: string; requestedAt: Date; variants: number }
  | { required: true; state: "approved"; approvedBy: string; approvedAt: Date }
  | { required: true; state: "declined"; declinedBy: string; declinedAt: Date; note: string | null };

/**
 * Whether this campaign needs a second person, and whether it has one.
 *
 * The variant count is recomputed rather than read from the request, because a campaign
 * can grow after approval — a segment gains products, or its filter is widened. An
 * approval granted for four hundred products is not an approval for forty thousand.
 */
export async function approvalFor(shopId: string, campaignId: string): Promise<ApprovalState> {
  const settings = await readSettings(shopId);
  const { threshold } = approvalPolicyOf(settings as unknown as { approvalThreshold?: unknown });
  if (threshold === null) return { required: false };

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { schedule: true },
  });
  if (!campaign) return { required: false };

  const variants = await prisma.variantIndex.count({
    where: astToWhere(shopId, await scopeOf(shopId, campaign)),
  });
  if (variants <= threshold) return { required: false };

  const approval = await prisma.approval.findFirst({
    where: { campaignId },
    orderBy: { requestedAt: "desc" },
  });

  if (!approval) return { required: true, state: "none" };

  if (approval.declinedAt && approval.declinedBy) {
    return {
      required: true,
      state: "declined",
      declinedBy: approval.declinedBy,
      declinedAt: approval.declinedAt,
      note: approval.note,
    };
  }

  if (approval.approvedAt && approval.approvedBy) {
    // An approval granted for four hundred products is not an approval for forty
    // thousand. A campaign that grew past what was signed off needs asking again.
    if (variants > approval.variantsAtRequest) {
      return { required: true, state: "none" };
    }

    return {
      required: true,
      state: "approved",
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
    };
  }

  return {
    required: true,
    state: "pending",
    requestedBy: approval.requestedBy,
    requestedAt: approval.requestedAt,
    variants: approval.variantsAtRequest,
  };
}

export async function requestApproval(
  shopId: string,
  campaignId: string,
  requestedBy: string,
): Promise<void> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { schedule: true },
  });

  const variants = await prisma.variantIndex.count({
    where: astToWhere(shopId, await scopeOf(shopId, campaign)),
  });

  // A fresh request supersedes an open one rather than colliding with the unique index.
  // Two people asking at once is one question.
  await prisma.approval.deleteMany({
    where: { campaignId, approvedAt: null, declinedAt: null },
  });

  await prisma.approval.create({
    data: { shopId, campaignId, requestedBy, variantsAtRequest: variants },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: requestedBy,
      action: "approval.requested",
      entity: "campaign",
      entityId: campaignId,
      after: { variants } as never,
    },
  });

  logger.info("approval requested", { shopId, campaignId, variants });
}

export class SelfApprovalError extends Error {
  constructor() {
    super("An approval has to come from somebody other than the person who asked for it.");
    this.name = "SelfApprovalError";
  }
}

/**
 * Records a decision.
 *
 * Refuses self-approval, which is the entire point of the rule. Anyone can click a button;
 * what a two-person rule buys is that a second person looked, and an implementation that
 * let the author approve their own campaign would be a checkbox pretending to be a control.
 */
export async function decideApproval(
  shopId: string,
  campaignId: string,
  actor: string,
  decision: "approve" | "decline",
  note?: string,
): Promise<void> {
  const approval = await prisma.approval.findFirstOrThrow({
    where: { campaignId, shopId, approvedAt: null, declinedAt: null },
  });

  if (approval.requestedBy === actor) throw new SelfApprovalError();

  await prisma.approval.update({
    where: { id: approval.id },
    data:
      decision === "approve"
        ? { approvedBy: actor, approvedAt: new Date(), note: note ?? null }
        : { declinedBy: actor, declinedAt: new Date(), note: note ?? null },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor,
      action: `approval.${decision}d`,
      entity: "campaign",
      entityId: campaignId,
      before: { requestedBy: approval.requestedBy } as never,
      after: { variants: approval.variantsAtRequest, note: note ?? null } as never,
    },
  });

  logger.info("approval decided", { shopId, campaignId, decision, actor });
}

/**
 * Why a run may not start, or null if it may.
 *
 * Checked in the run path. An approval the scheduler can walk past is not an approval, and
 * a scheduled campaign is exactly where somebody would notice too late.
 */
export async function blockedPendingApproval(
  shopId: string,
  campaignId: string,
): Promise<string | null> {
  const approval = await approvalFor(shopId, campaignId);
  if (!approval.required) return null;

  switch (approval.state) {
    case "approved":
      return null;
    case "pending":
      return (
        `This campaign is waiting for approval. ${approval.requestedBy} asked on ` +
        `${approval.requestedAt.toISOString().slice(0, 10)}; somebody else needs to approve it.`
      );
    case "declined":
      return (
        `This campaign was declined by ${approval.declinedBy}` +
        (approval.note ? `: ${approval.note}` : ".") +
        " Ask for approval again once it has been changed."
      );
    default:
      return "This campaign is large enough to need a second person's approval before it can run.";
  }
}
