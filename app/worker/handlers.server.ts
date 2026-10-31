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

import { SCHEDULER_ACTOR } from "../lib/audit/actor";
import type { CampaignState } from "../lib/lifecycle/transitions";
import prisma from "../db.server";
import { adminClientForShop } from "../services/admin-client.server";
import type { JobRef, JobResult, QueueName } from "./queues";

export async function handleJob(name: QueueName, ref: JobRef): Promise<JobResult> {
  switch (name) {
    case "execution":
      // A drift decision over many prices is execution too: a put-back is a run, and
      // keeping or leaving thousands is the same queue's kind of work (#822).
      return ref.drift ? driftDecisionJob(ref) : runCampaignJob(ref);
    case "audit":
      return auditJob(ref);
    case "sync":
      return syncJob(ref);
    // A shop's products webhooks, persisted by the route and drained here (#811): the
    // queue's first move from the web process, a change of caller as this said it would be.
    case "webhooks":
      return webhooksJob(ref);
    // A campaign's stored plan, for its page and dialogs (#812): the run's own plan is still
    // made inside the run, and is the only one that decides prices.
    case "planning":
      return planningJob(ref);
    // Verification is performed inside the run today. It has a queue so the topology is
    // complete and so moving it is a change of caller rather than a change of design.
    case "verification":
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

  // Thrown, not logged and returned: a job that returns has succeeded as far as the queue
  // is concerned, so a queued apply or revert with no client used to vanish with its
  // job marked done (#707). Now it fails where the queue's own failure handling sees it.
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error(`No usable session for ${shop.domain}; the run did not start.`);

  const { runCampaign } = await import("../services/campaigns/run.server");
  await runCampaign(ref.shopId, ref.campaignId, client, {
    revert: ref.revert === true,
    resume: ref.resume === true,
    // Claimed and answered "under way" before it was queued: one that cannot run says so (#1046).
    queued: true,
    // The actor `queueRun` carries -- the merchant, Flow or the scheduler (#746). A job
    // queued before jobs carried one has none, and was queued by the scheduler.
    actor: ref.actor ?? SCHEDULER_ACTOR,
    skipVariantGids: ref.skipVariantGids,
    skipReason: ref.skipReason,
    // Flow's End campaign, whose edited prices this run finds and keeps (#794).
    ...(ref.keepEdited ? { keepEdited: true } : {}),
    // A press of Apply without the word, checked again on this run's own plan (#812).
    ...(ref.untypedPress ? { untypedPress: true } : {}),
    ...(ref.claimedFrom ? { claimedFrom: ref.claimedFrom as CampaignState } : {}),
  });
}

/**
 * Plans a campaign for its page and stores the answer (#812). Without a usable session the
 * plan is still made: it says each market's write is decided at run time, rather than leaving
 * the page with no numbers at all.
 */
async function planningJob(ref: JobRef): Promise<void> {
  if (!ref.campaignId) return;

  const shop = await prisma.shop.findUnique({
    where: { id: ref.shopId },
    select: { domain: true, uninstalledAt: true },
  });
  if (!shop || shop.uninstalledAt) return;

  const client = await adminClientForShop(shop.domain);
  const { runPlanningJob } = await import("../services/campaigns/plan-summary.server");
  await runPlanningJob(ref.shopId, ref.campaignId, client);
}

/**
 * One decision over a campaign's drifted prices, handed over by the drift page (#822).
 *
 * A put-back needs the shop's client and is refused without one. Keeping or leaving needs
 * none, so a missing session does not hold them up. Either way the outcome is recorded as
 * the decision's audit entry, which is what the page following it reads.
 */
async function driftDecisionJob(ref: JobRef): Promise<void> {
  if (!ref.campaignId || !ref.drift) return;

  const shop = await prisma.shop.findUnique({
    where: { id: ref.shopId },
    select: { domain: true, uninstalledAt: true },
  });
  if (!shop || shop.uninstalledAt) return;

  const client = ref.drift.resolution === "reassert" ? await adminClientForShop(shop.domain) : null;
  const { executeDriftBatch } = await import("../services/drift-queue.server");
  await executeDriftBatch(
    ref.shopId,
    { campaignId: ref.campaignId, ...ref.drift },
    ref.actor ?? SCHEDULER_ACTOR,
    client,
  );
}

/**
 * One turn of a shop's products-webhook drain (#811). The job names the shop and nothing
 * else: the deliveries are rows, read again here, so a job that waited behind a storm acts
 * on what is waiting now -- including deliveries persisted after it was rung.
 */
async function webhooksJob(ref: JobRef): Promise<JobResult> {
  const { drainShopWebhooks } = await import("../services/webhook-queue.server");
  return drainShopWebhooks(ref.shopId);
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

  // The recapture page's, too many ladder reads for its request (#1105). Handed the client
  // or null alike: a missing session is recorded on the recapture, where the page following
  // it says so, rather than thrown for a retry of a recapture the page has called stopped.
  if (ref.recaptureId) {
    const { runQueuedRecapture } = await import("../services/recapture-job.server");
    await runQueuedRecapture(ref.shopId, ref.recaptureId, client);
    return;
  }

  // Flow's large capture (#773), with the shop's client for its wholesale prices' quantity
  // ladders, as the recapture page captures them (#1092).
  if (ref.recaptureSegmentId) {
    const { captureForFlow } = await import("../services/flow/flow-capture.server");
    await captureForFlow(ref.shopId, ref.recaptureSegmentId, client);
    return;
  }

  // The whole catalogue, from Home's Sync button (#801). Thrown rather than returned on a
  // missing session, like a queued run (#707): a job that returns has succeeded, and Home
  // would wait on a sync nobody is running until it went stale.
  if (ref.fullSync) {
    const { runFullSync } = await import("../services/sync-job.server");
    if (!client) {
      await prisma.shop.update({
        where: { id: ref.shopId },
        data: {
          syncStartedAt: null,
          syncPhase: null,
          syncHeartbeatAt: null,
          syncFailure: "The sync could not start: the app has no working session for this store. Open the app again from Shopify admin, then run it again.",
        },
      });
      throw new Error(`No usable session for ${shop.domain}; the sync did not start.`);
    }
    await runFullSync(ref.shopId, client, ref.actor ?? "shopify");
    return;
  }

  if (!client) return;

  const { syncMarkets } = await import("../services/markets-sync.server");
  await syncMarkets(client, ref.shopId);
}
