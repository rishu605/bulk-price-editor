/**
 * Product create / update / delete: received here, handled by the worker (#811).
 *
 * RFC §2's ingress, which this route did not have until #811: verify the raw body's HMAC,
 * insert the delivery into `webhook_events` (unique on Shopify's webhook id, which is the
 * dedup), hand the shop's drain to the worker, answer 200. One query and one enqueue, and
 * nothing else in the request.
 *
 * It used to do all of it here -- mirror upsert, tombstoning, drift, enrolment with its
 * baseline capture, drift notifications -- in the web process's ten pooled connections. A
 * 100k-variant run sends thousands of `products/update` echoes, and after anchor-perf's
 * revert died (#803) they held every page at the pool timeout for 45 minutes while
 * Shopify's retries of the ones that timed out kept it there. The work itself is
 * `processProductsWebhook`, unchanged in what it decides; `webhook-queue.server` is how a
 * delivery reaches it.
 *
 * Verified without `authenticate.webhook`, which loads the shop's offline session (and
 * refreshes its token near expiry) to hand back an `admin` client the queued path never
 * uses: that was a second query per webhook, and in a storm a token refresh raced by every
 * webhook arriving at once. `verifyWebhook` checks what the library's `webhooks.validate`
 * checks.
 *
 * Without a worker queue -- development without Redis, or a deployment missing it -- there
 * is nobody to hand the delivery to, so it is handled here, as it always was, through the
 * library's `authenticate.webhook` for the `admin` client a product never seen needs. A
 * delivery already recorded as handled is not handled twice there either.
 *
 * Shopify is answered 200 once the delivery is persisted, even if the queue does not take
 * the job: the row is the truth, and the worker's tick rings any shop whose deliveries have
 * waited too long (`ringStrandedWebhooks`). A 5xx would have Shopify send it again, which is
 * what sustained #803.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { verifyWebhook } from "../lib/shopify/webhook-hmac.server";
import { toAdminClient } from "../services/admin-client.server";
import { processProductsWebhook, shopContext } from "../services/products-webhook.server";
import { recordedWebhook } from "../services/webhook-log.server";
import { persistDelivery } from "../services/webhook-queue.server";
import { enqueueWithin, webQueue } from "../worker/web-queue.server";

/**
 * How long a delivery waits for Redis to take its job. Well inside Shopify's five seconds,
 * and nothing is lost past it: the row is persisted, and the tick rings the shop.
 */
const WEBHOOK_ENQUEUE_TIMEOUT_MS = 1_000;

export async function action(args: ActionFunctionArgs): Promise<Response> {
  const queue = webQueue();
  if (!queue) return inline(args);

  const delivery = await verifyWebhook(args.request);
  const persisted = await persistDelivery(delivery);
  // A shop never recorded, or a redelivery of one already handled or in hand: acknowledged.
  if (!persisted.shopId || persisted.status !== "RECEIVED") return new Response();

  try {
    await enqueueWithin(queue, "webhooks", { shopId: persisted.shopId }, WEBHOOK_ENQUEUE_TIMEOUT_MS);
  } catch (error) {
    logger.warn("products webhook persisted but not handed to the worker; the tick will ring its shop", {
      shop: delivery.shop,
      webhookEventId: persisted.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return new Response();
}

/** No worker queue: handled in the request, as before #811. */
const inline = recordedWebhook(async ({ request }: ActionFunctionArgs) => {
  const { shop: shopDomain, topic, payload, admin } = await authenticate.webhook(request);

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain }, select: { id: true, domain: true } });
  // A webhook for a shop we have never recorded is not an error: it can arrive
  // between install and first load. Acknowledge so Shopify does not retry.
  if (!shop) return new Response();

  // A redelivery of one this path already handled: Shopify retries until answered with a
  // 2xx, and the answer can be lost after the work was done. Handled once, here as in the
  // worker (#811).
  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (webhookId) {
    const prior = await prisma.webhookEvent.findUnique({ where: { webhookId }, select: { status: true } });
    if (prior?.status === "PROCESSED") return new Response();
  }

  await processProductsWebhook(
    shopContext(shop, async () => (admin ? toAdminClient(admin) : null)),
    topic,
    payload,
  );
  return new Response();
});
