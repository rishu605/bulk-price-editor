/**
 * Feedback from inside the app, and closing the loop on it.
 *
 * A beta cohort keeps talking to you for exactly as long as talking to you appears to
 * change something. So the parts that matter are not the form — they are that the
 * merchant can see their feedback arrived, that it gets triaged rather than accumulating,
 * and that somebody tells them when it ships.
 *
 * Context is captured, never asked for. Which screen they were on, what plan they are on,
 * how big their catalogue is: we know all of it, and every question a form asks is a
 * reason somebody closes it instead.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";

export type Sentiment = "problem" | "idea" | "praise";

/** Three, because a longer list makes people stop and think about which one to pick. */
export const SENTIMENTS: Sentiment[] = ["problem", "idea", "praise"];

export function isSentiment(value: unknown): value is Sentiment {
  return typeof value === "string" && SENTIMENTS.includes(value as Sentiment);
}

export interface FeedbackContext {
  route?: string;
  actor?: string;
}

/** How long a message may be before it is truncated rather than rejected. */
export const MAX_MESSAGE = 4_000;

export async function recordFeedback(
  shopId: string,
  message: string,
  sentiment: Sentiment,
  context: FeedbackContext = {},
): Promise<{ ok: boolean; message: string }> {
  const trimmed = message.trim();
  if (!trimmed) {
    return { ok: false, message: "Write something first — even a sentence is useful." };
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { planTier: true },
  });

  const variantCount = await prisma.variantIndex.count({
    where: { shopId, deletedAt: null },
  });

  await prisma.feedback.create({
    data: {
      shopId,
      // Truncated rather than refused. Somebody who has written two thousand words about
      // a problem should not lose them to a validation error.
      message: trimmed.slice(0, MAX_MESSAGE),
      sentiment,
      route: context.route ?? null,
      planTier: shop?.planTier ?? undefined,
      variantCount,
      actor: context.actor ?? null,
    },
  });

  logger.info("feedback received", { shopId, sentiment, route: context.route });

  return {
    ok: true,
    message:
      sentiment === "praise"
        ? "Thank you — that genuinely helps."
        : "Got it. We read every one of these, and we will tell you if this ships.",
  };
}

/** What a merchant has sent, so they can see it arrived and what came of it. */
export async function feedbackFor(shopId: string, limit = 20) {
  return prisma.feedback.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export type TriageStatus = "p5" | "p6" | "wont-do" | "shipped";

/**
 * The weekly review: everything nobody has looked at yet.
 *
 * Untriaged rather than unread, because the ritual that keeps this useful is categorising
 * every item — into the next milestone, a later one, or explicitly not doing it. An
 * item with no decision is the one that quietly turns a beta programme into a suggestion
 * box.
 */
export async function untriaged(limit = 100) {
  return prisma.feedback.findMany({
    where: { status: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { shop: { select: { domain: true } } },
  });
}

export async function triage(
  id: string,
  status: TriageStatus,
  theme?: string,
): Promise<void> {
  await prisma.feedback.update({
    where: { id },
    data: {
      status,
      ...(theme ? { theme } : {}),
      ...(status === "shipped" ? { shippedAt: new Date() } : {}),
    },
  });
}

/**
 * Recurring themes, most common first.
 *
 * The synthesis that feeds the roadmap. One merchant asking for something is an anecdote;
 * eight asking for the same thing in different words is the next ticket, and the only way
 * to see that is to have been putting a theme on each one all along.
 */
export async function themes(): Promise<Array<{ theme: string; count: number }>> {
  const rows = await prisma.feedback.groupBy({
    by: ["theme"],
    where: { theme: { not: null } },
    _count: true,
    orderBy: { _count: { theme: "desc" } },
  });

  return rows
    .filter((row): row is typeof row & { theme: string } => row.theme !== null)
    .map((row) => ({ theme: row.theme, count: row._count }));
}

/**
 * Feedback that shipped and whose author has not been told.
 *
 * This is the thing that keeps a cohort engaged, and it is also the easiest thing in the
 * world to forget — which is why it is a query rather than a habit.
 */
export async function awaitingNotice() {
  return prisma.feedback.findMany({
    where: { status: "shipped", shippedAt: { not: null }, notifiedAt: null },
    include: { shop: { select: { domain: true } } },
    orderBy: { shippedAt: "asc" },
  });
}

export async function markNotified(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  await prisma.feedback.updateMany({
    where: { id: { in: [...ids] } },
    data: { notifiedAt: new Date() },
  });
}
