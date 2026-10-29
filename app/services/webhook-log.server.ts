/**
 * Every webhook delivery, recorded in `webhook_events` (#712).
 *
 * Three of the paging alerts -- error-spike, shop-error-spike and webhook-lag -- divide by,
 * or read the lag from, this table, and nothing in the app wrote to it: only the chaos
 * scenario that tests the alerts, by hand. In production the denominator was always 0, the
 * lag always null, and none of the three could page.
 *
 * Wraps a webhook route's action. The delivery's id, topic and shop come from Shopify's own
 * headers, and are recorded only once the route has handled the request -- by which point
 * `authenticate.webhook` has verified its signature -- or failed after verifying it. A
 * request refused as unauthenticated (a 4xx thrown before any handling) is not a delivery,
 * and writes nothing.
 *
 * Metadata only: the alerts need counts and times, and a products payload is large and
 * carries prices. Best-effort: recording a delivery must never fail it.
 *
 * The products route records its deliveries itself when a worker queue takes them (#811):
 * the row is the delivery, written before the answer and with its body until the worker has
 * handled it (`webhook-queue.server`). This wrapper is for every other route, and for the
 * products route handling a delivery inline when there is no queue.
 */

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";

type WebhookAction = (args: ActionFunctionArgs) => Promise<Response>;

/** The topic, as Shopify's `X-Shopify-Topic` header spells it, whose job is to erase a shop. */
const SHOP_REDACT = "shop/redact";

/** What an erased shop's deliveries are recorded under. Not a hostname, so never a shop's. */
export const ERASED_SHOP = "(redacted)";

export function recordedWebhook(handle: WebhookAction): WebhookAction {
  return async (args) => {
    const receivedAt = new Date();
    try {
      const response = await handle(args);
      await record(args.request.headers, receivedAt, response.ok ? "PROCESSED" : "FAILED", response.ok ? undefined : `HTTP ${response.status}`);
      return response;
    } catch (thrown) {
      // A thrown 4xx is the library refusing a request it could not verify: not a delivery.
      if (!(thrown instanceof Response && thrown.status < 500)) {
        await record(args.request.headers, receivedAt, "FAILED", thrown instanceof Error ? thrown.message : String(thrown));
      }
      throw thrown;
    }
  };
}

async function record(
  headers: Headers,
  receivedAt: Date,
  status: "PROCESSED" | "FAILED",
  failureReason?: string,
): Promise<void> {
  const webhookId = headers.get("x-shopify-webhook-id");
  const topic = headers.get("x-shopify-topic");
  const shopDomain = headers.get("x-shopify-shop-domain");
  if (!webhookId || !topic || !shopDomain) return;

  // A `shop/redact` that succeeded has just erased this shop, deliveries included, and
  // recording it under the domain would write the domain straight back (#785). Still
  // recorded -- it is traffic, and the alerts count it -- but as nobody's. One that failed
  // erased nothing: it keeps the domain, because whoever looks into it needs to know
  // whose it was, and Shopify's retry overwrites it once one succeeds.
  const erased = topic === SHOP_REDACT && status === "PROCESSED";

  try {
    const shop = erased
      ? null
      : await prisma.shop.findUnique({ where: { domain: shopDomain }, select: { id: true } });
    const processedAt = new Date();
    await prisma.webhookEvent.upsert({
      where: { webhookId },
      create: {
        webhookId,
        shopId: shop?.id ?? null,
        shopDomain: erased ? ERASED_SHOP : shopDomain,
        topic,
        payload: {},
        status,
        attempts: 1,
        receivedAt,
        processedAt,
        failureReason: failureReason?.slice(0, 500) ?? null,
      },
      // Shopify retries a delivery under the same id until it is answered with a 2xx.
      update: {
        ...(erased ? { shopId: null, shopDomain: ERASED_SHOP } : {}),
        // A products delivery persisted for the worker and then handled inline -- a web
        // process restarted without its queue (#811) -- keeps no body once handled.
        payload: {},
        status,
        attempts: { increment: 1 },
        processedAt,
        failureReason: failureReason?.slice(0, 500) ?? null,
      },
    });
  } catch (error) {
    logger.warn("could not record a webhook delivery", {
      topic,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Deletes every delivery recorded for a shop, for `shop/redact` (#785).
 *
 * The cascade from `Shop` clears the ones attributed to it. Not the rest: a delivery that
 * arrived before the shop row existed, or after it was gone, is recorded with no shop and
 * only the domain -- which is the one thing on the row worth erasing.
 */
export async function forgetShopDeliveries(domain: string): Promise<number> {
  const { count } = await prisma.webhookEvent.deleteMany({ where: { shopDomain: domain } });
  return count;
}

/** How long a delivery is kept: far past the alerts' fifteen minutes, long enough to look into. */
export const WEBHOOK_LOG_DAYS = 7;

/**
 * Deletes deliveries older than `WEBHOOK_LOG_DAYS`, a batch at a time.
 *
 * Every delivery now writes a row, and a large store's catalogue sends thousands a day: kept
 * for ever, the table grows without end. Bounded per call, so a backlog drains over a few
 * scheduler ticks rather than in one long delete.
 */
export async function pruneWebhookLog(now: Date = new Date(), batch = 5_000): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_LOG_DAYS * 24 * 60 * 60_000);
  const old = await prisma.webhookEvent.findMany({
    where: { receivedAt: { lt: cutoff } },
    select: { id: true },
    take: batch,
  });
  if (old.length === 0) return 0;
  const { count } = await prisma.webhookEvent.deleteMany({ where: { id: { in: old.map((row) => row.id) } } });
  return count;
}
