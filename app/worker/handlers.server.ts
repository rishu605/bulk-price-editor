/**
 * What each job class actually does.
 *
 * One dispatch point rather than a handler registered next to each queue, so the set of
 * things a worker can be asked to do is readable in one place — and so a job class
 * cannot quietly acquire a second meaning somewhere else in the tree.
 *
 * Every handler re-reads its work from the database. The job carries ids only, so a job
 * that sat in Redis for an hour acts on the world as it is now rather than as it was
 * when somebody enqueued it. That matters most for `execution`: a campaign cancelled
 * while its job was queued must not run.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { adminClientForShop } from "../services/admin-client.server";
import type { JobRef, QueueName } from "./queues";

export async function handleJob(name: QueueName, ref: JobRef): Promise<void> {
  switch (name) {
    case "execution":
      return runCampaignJob(ref);
    case "audit":
      return auditJob(ref);
    case "sync":
      return syncJob(ref);
    // Planning, verification and webhook ingestion are performed inside the run and the
    // webhook route today. They have queues so the topology is complete and so moving
    // them is a change of caller rather than a change of design.
    case "planning":
    case "verification":
    case "webhooks":
      return;
    default: {
      // Exhaustiveness, not defensiveness. Without it, adding a name to `QUEUE_NAMES`
      // compiles: the runtime gives it a Queue and a Worker, this switch falls straight
      // through, and every job on it is marked complete having done nothing. Silence is
      // the worst outcome available here, so `never` turns it into a build failure and
      // the throw covers a name arriving from outside TypeScript.
      const unhandled: never = name;
      throw new Error(`No handler for queue ${String(unhandled)}`);
    }
  }
}

async function runCampaignJob(ref: JobRef): Promise<void> {
  if (!ref.campaignId) return;

  const shop = await prisma.shop.findUnique({
    where: { id: ref.shopId },
    select: { domain: true, uninstalledAt: true },
  });
  // An uninstalled shop is an expected state for a queued job, not an error. Its tokens
  // are gone and writing to it would fail in a way that reads like an outage.
  if (!shop || shop.uninstalledAt) return;

  const client = await adminClientForShop(shop.domain);
  if (!client) {
    logger.warn("no usable session for queued run", { shopId: ref.shopId });
    return;
  }

  const { runCampaign } = await import("../services/campaigns/run.server");
  await runCampaign(ref.shopId, ref.campaignId, client, { revert: ref.revert === true });
}

async function auditJob(ref: JobRef): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { id: ref.shopId },
    select: { domain: true, uninstalledAt: true },
  });
  if (!shop || shop.uninstalledAt) return;

  const client = await adminClientForShop(shop.domain);
  if (!client) return;

  const { auditMirror } = await import("../services/mirror-audit.server");
  await auditMirror(client, ref.shopId);
}

async function syncJob(ref: JobRef): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { id: ref.shopId },
    select: { domain: true, uninstalledAt: true },
  });
  if (!shop || shop.uninstalledAt) return;

  const client = await adminClientForShop(shop.domain);
  if (!client) return;

  const { syncMarkets } = await import("../services/markets-sync.server");
  await syncMarkets(client, ref.shopId);
}
