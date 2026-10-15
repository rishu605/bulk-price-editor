/**
 * A bulk run waiting for its turn at Shopify (#1054).
 *
 * Shopify runs a limited number of bulk mutations per app and shop at once, and refuses
 * one past the limit. The run that was refused keeps its claim and asks again (see
 * `submitBulkMutation`); this is what it says while it does, in the two places a merchant
 * looks: the campaign's history, and its Status card, which would otherwise go on saying
 * "Writing prices now" over a run that has written nothing and is not allowed to yet.
 */

import prisma from "../../db.server";
import { formatCount } from "../../lib/format/display";
import { noteCampaign } from "./lifecycle.server";

/** How every waiting note starts, so the Status card can tell one from any other entry. */
const WAITING_BEHIND = "Waiting behind ";

/** A run with a process behind it. */
const LIVE_RUN = ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] as const;

/**
 * Records, in the campaign's history, that its run is waiting and behind whom: the
 * campaigns whose bulk operations this shop still has running. Once per sentence --
 * `noteCampaign` skips a repeat, and this is called on every refusal.
 */
export async function noteBulkWait(
  shopId: string,
  campaignId: string,
  run: { id: string; actor: string; prices: number },
): Promise<void> {
  const running = await prisma.bulkOperationRecord.findMany({
    where: { shopId, kind: "MUTATION", status: { in: ["CREATED", "RUNNING"] } },
    orderBy: { submittedAt: "asc" },
    select: { run: { select: { campaign: { select: { name: true } } } } },
  });
  const names = [...new Set(running.flatMap((operation) => (operation.run ? [`"${operation.run.campaign.name}"`] : [])))];

  // Shopify's refusal names nobody, and an operation this app has no record of -- one sent
  // by a process that died before recording it -- still takes a turn.
  const behind =
    names.length === 0
      ? "another bulk price update still running in Shopify for this store"
      : `${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}, whose bulk price ` +
        `${names.length === 1 ? "update is" : "updates are"} still running in Shopify`;
  const prices = run.prices === 1 ? "price is" : "prices are";

  await noteCampaign(
    shopId,
    campaignId,
    `${WAITING_BEHIND}${behind}. Shopify runs a limited number of bulk updates per store at once, so this ` +
      `campaign's ${formatCount(run.prices)} ${prices} sent as soon as one finishes; nothing has been written yet.`,
    { actor: run.actor, runId: run.id },
  );
}

/**
 * What the Status card says while the campaign's run waits for its turn, or null when it
 * is not waiting: no run is live, Shopify has accepted its operation, or its latest entry
 * is about something else.
 */
export async function bulkWaitOf(shopId: string, campaignId: string): Promise<string | null> {
  const run = await prisma.campaignRun.findFirst({
    where: { shopId, campaignId, status: { in: [...LIVE_RUN] }, NOT: { occurrenceKey: { startsWith: "VARIANT-" } } },
    select: { id: true },
  });
  if (!run) return null;
  if ((await prisma.bulkOperationRecord.count({ where: { runId: run.id, kind: "MUTATION" } })) > 0) return null;

  const latest = await prisma.auditLogEntry.findFirst({
    where: { shopId, entity: "Campaign", entityId: campaignId, action: "campaign.transition" },
    orderBy: { createdAt: "desc" },
    select: { after: true },
  });
  const entry = latest?.after as { reason?: string; runId?: string } | null;
  return entry?.runId === run.id && entry.reason?.startsWith(WAITING_BEHIND) ? entry.reason : null;
}
