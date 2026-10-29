/**
 * Products webhooks: persisted by the web process, handled by the worker (#811).
 *
 * RFC §2's ingress, which the products route did not have: verify, insert `webhook_events`,
 * enqueue, answer 200 -- and do all the processing asynchronously. The route used to upsert
 * the mirror, look for drift, enrol and notify inline, in the web process's ten pooled
 * connections. A 100k-variant run sends thousands of `products/update` echoes; after
 * anchor-perf's revert died (#803) they held the app at its pool timeout for 45 minutes,
 * Shopify's retries of the ones that timed out kept it there, and a later run proved the
 * web pool starved on the echoes alone even with the run itself in the worker.
 *
 * Three parts:
 *
 *   `persistDelivery` -- the route's one query. The delivery's row, unique on Shopify's
 *   webhook id, so a redelivery is the same row and is handled once.
 *
 *   `drainShopWebhooks` -- the worker's, one shop at a time (see `jobOptionsFor` for why
 *   never two at once). It reads the shop's oldest waiting deliveries, takes each product's
 *   together and handles only the newest (`coalesceDeliveries`), and drops our own echoes
 *   before any other work (`processProductsWebhook`). A turn is bounded, so a storm drains
 *   between other shops' turns rather than ahead of them.
 *
 *   `ringStrandedWebhooks` -- the worker tick's. A delivery is persisted before its job is
 *   asked for, and the asking can fail (Redis away) or be lost (Redis restarted without its
 *   data); the row is the truth, so the tick rings any shop whose deliveries have waited
 *   too long. Shopify is answered 200 either way: its retries are what sustained #803.
 */

import { randomUUID } from "node:crypto";

import { Prisma, type WebhookStatus } from "@prisma/client";

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { coalesceDeliveries } from "../lib/catalog/webhook-coalesce";
import type { VerifiedWebhook } from "../lib/shopify/webhook-hmac.server";
import type { QueueRuntime } from "../worker/queue-runtime.server";
import { adminClientForShop } from "./admin-client.server";
import { processProductsWebhook, productGidOf, shopContext, type ProductsOutcome } from "./products-webhook.server";

export interface PersistedDelivery {
  id: string;
  /** Null for a shop never recorded: acknowledged, and nothing to hand on. */
  shopId: string | null;
  /** Anything but RECEIVED is a redelivery of one already handled, or being handled. */
  status: WebhookStatus;
}

/**
 * The delivery, recorded once (#811): one statement, the only query the route makes.
 *
 * Its shop is found in the same statement. One never recorded -- a webhook between install
 * and first load -- is not an error: the row is written handled, with no payload, as the
 * route always acknowledged such a delivery, and nothing is enqueued.
 *
 * A redelivery is the same row (`webhookId` is unique). It counts as another delivery, and
 * otherwise leaves the row as it is: one still waiting is still waiting and will be handled
 * once, one handled is not handled again. The exception is a row recorded as failed by the
 * inline path, which answered Shopify with an error so that it would send it again -- that
 * one is taken up again, here, with the body the inline path did not keep.
 */
export async function persistDelivery(delivery: VerifiedWebhook): Promise<PersistedDelivery> {
  const now = Prisma.sql`(${new Date()}::timestamptz AT TIME ZONE 'UTC')`;
  const rows = await prisma.$queryRaw<PersistedDelivery[]>`
    WITH shop AS (SELECT "id" FROM "shops" WHERE "domain" = ${delivery.shop})
    INSERT INTO "webhook_events"
      ("id", "webhookId", "shopId", "shopDomain", "topic", "payload", "subjectGid",
       "status", "attempts", "processAttempts", "receivedAt", "processedAt")
    SELECT
      ${randomUUID()}, ${delivery.webhookId}, shop."id", ${delivery.shop}, ${delivery.topic},
      CASE WHEN shop."id" IS NULL THEN '{}'::jsonb ELSE ${JSON.stringify(delivery.payload)}::jsonb END,
      ${productGidOf(delivery.payload)},
      (CASE WHEN shop."id" IS NULL THEN 'PROCESSED' ELSE 'RECEIVED' END)::"WebhookStatus",
      1, 0, ${now}, CASE WHEN shop."id" IS NULL THEN ${now} END
    FROM (SELECT 1) AS one LEFT JOIN shop ON true
    ON CONFLICT ("webhookId") DO UPDATE SET
      "attempts" = "webhook_events"."attempts" + 1,
      "status" = CASE WHEN "webhook_events"."status" = 'FAILED' AND EXCLUDED."shopId" IS NOT NULL
        THEN 'RECEIVED'::"WebhookStatus" ELSE "webhook_events"."status" END,
      "payload" = CASE WHEN "webhook_events"."status" = 'FAILED' AND EXCLUDED."shopId" IS NOT NULL
        THEN EXCLUDED."payload" ELSE "webhook_events"."payload" END,
      "shopId" = COALESCE("webhook_events"."shopId", EXCLUDED."shopId"),
      "subjectGid" = COALESCE("webhook_events"."subjectGid", EXCLUDED."subjectGid"),
      "processAttempts" = CASE WHEN "webhook_events"."status" = 'FAILED' THEN 0 ELSE "webhook_events"."processAttempts" END,
      "processedAt" = CASE WHEN "webhook_events"."status" = 'FAILED' AND EXCLUDED."shopId" IS NOT NULL
        THEN NULL ELSE "webhook_events"."processedAt" END
    RETURNING "id", "shopId", "status"`;
  return rows[0];
}

/** How many deliveries one turn of a shop's drain reads before it yields to other shops. */
export const DRAIN_TURN = 100;

/**
 * Tries at one delivery that throws before it is set aside as failed, matching the queue's
 * own attempts: the job is retried with backoff for a fault that passes, and a payload that
 * fails every time stops holding its shop up after this many.
 */
export const MAX_PROCESS_ATTEMPTS = 5;

type Tally = Record<ProductsOutcome | "superseded", number>;

/**
 * One turn of a shop's waiting products deliveries (#811). `"again"` when it stopped with a
 * full turn read, so its next turn queues behind other shops' rather than running on.
 *
 * Each product's deliveries are marked handled together, after the ones handled succeeded:
 * a turn that dies part-way handles that product again, newest again, rather than leaving
 * an older delivery to be taken for the newest next time. That is at-least-once for the one
 * product in hand when a worker dies, which the handling tolerates -- an upsert, a drift
 * event collapsed per variant, an enrolment appended and deduplicated when claimed -- and
 * exactly once otherwise, because a shop never has two drains (`jobOptionsFor`).
 */
export async function drainShopWebhooks(shopId: string): Promise<"again" | undefined> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, domain: true } });
  // Erased (`shop/redact`), and its deliveries with it.
  if (!shop) return undefined;
  // One session, opened only if a delivery needs one, for the whole turn.
  const context = shopContext(shop, () => adminClientForShop(shop.domain));

  const oldest = await prisma.webhookEvent.findMany({
    where: { shopId, status: "RECEIVED", subjectGid: { not: null } },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: DRAIN_TURN,
    select: { subjectGid: true },
  });

  const tally: Tally = { applied: 0, deleted: 0, echo: 0, "no-currency": 0, ignored: 0, superseded: 0 };
  for (const subjectGid of new Set(oldest.map((row) => row.subjectGid!))) {
    const waiting = await prisma.webhookEvent.findMany({
      where: { shopId, subjectGid, status: "RECEIVED" },
      select: { id: true, topic: true, payload: true, receivedAt: true, processAttempts: true },
    });
    if (waiting.length === 0) continue;

    const { handle, superseded } = coalesceDeliveries(waiting);
    let failed: string | null = null;
    for (const delivery of handle) {
      try {
        tally[await processProductsWebhook(context, delivery.topic, delivery.payload)] += 1;
      } catch (error) {
        if (!(await setBack(delivery, error))) throw error;
        failed = delivery.id;
        break;
      }
    }
    // A product whose newest delivery failed for good is left for its next edit or the
    // catalogue sync, older deliveries with it: handling one of those instead would put
    // an older version of the product over whatever the failed one described.
    if (failed) {
      await settle([failed], "FAILED");
      await settle(waiting.map((delivery) => delivery.id).filter((id) => id !== failed), "FAILED", "a newer delivery for this product failed");
      continue;
    }
    await settle(waiting.map((delivery) => delivery.id), "PROCESSED");
    tally.superseded += superseded.length;
  }

  const handled = Object.values(tally).reduce((sum, count) => sum + count, 0);
  if (handled > 0) logger.info("products webhooks handled", { shopId, ...tally });
  return oldest.length === DRAIN_TURN ? "again" : undefined;
}

/**
 * A delivery that threw, counted. False to rethrow: the job is retried with backoff, and a
 * database that is briefly away costs one delivery an attempt, not every delivery in the
 * turn. True once it has failed `MAX_PROCESS_ATTEMPTS` times and is set aside.
 */
async function setBack(delivery: { id: string; processAttempts: number }, error: unknown): Promise<boolean> {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const exhausted = delivery.processAttempts + 1 >= MAX_PROCESS_ATTEMPTS;
  await prisma.webhookEvent.update({
    where: { id: delivery.id },
    data: { processAttempts: { increment: 1 }, failureReason: reason },
  });
  logger.warn("a products webhook could not be handled", {
    webhookEventId: delivery.id,
    attempts: delivery.processAttempts + 1,
    exhausted,
    error: reason,
  });
  return exhausted;
}

/**
 * Handled, with the body dropped: the log keeps metadata, as it does for every other
 * delivery, not a week of a catalogue's prices. `processedAt` is what webhook lag reads.
 */
async function settle(ids: string[], status: "PROCESSED" | "FAILED", failureReason?: string): Promise<void> {
  if (ids.length === 0) return;
  await prisma.webhookEvent.updateMany({
    where: { id: { in: ids }, status: "RECEIVED" },
    data: {
      status,
      processedAt: new Date(),
      // A failed one keeps its body, for whoever replays it; and its own reason, unless
      // it is failed for another's sake.
      ...(status === "PROCESSED" ? { payload: {}, failureReason: null } : failureReason ? { failureReason } : {}),
    },
  });
}

/** How long a delivery may wait before the tick takes its job to have been lost. */
export const STRANDED_AFTER_MS = 2 * 60_000;

/**
 * Rings every shop with deliveries waiting longer than `STRANDED_AFTER_MS` (#811). A shop
 * whose drain is merely busy has a job already, and the ring is absorbed by it; one whose
 * job was never taken or was lost gets one. Returns how many shops were rung.
 */
export async function ringStrandedWebhooks(queue: QueueRuntime, now: Date = new Date()): Promise<number> {
  const shops = await prisma.webhookEvent.groupBy({
    by: ["shopId"],
    where: { status: "RECEIVED", receivedAt: { lt: new Date(now.getTime() - STRANDED_AFTER_MS) }, shopId: { not: null } },
  });
  for (const { shopId } of shops) await queue.enqueue("webhooks", { shopId: shopId! });
  return shops.length;
}
