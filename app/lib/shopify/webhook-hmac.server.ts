/**
 * Verifying a Shopify webhook from its raw body, and nothing else (#811).
 *
 * The library's `authenticate.webhook` verifies the HMAC and then loads the shop's offline
 * session, refreshing its token when it is close to expiry, so it can hand back an `admin`
 * client. A queued products delivery needs no client -- the worker opens its own -- and in
 * an echo storm that session load was one more query per webhook against the web process's
 * ten connections, and a token refresh raced by every webhook that arrived in the same
 * moment. RFC §2's ingress is "raw-body HMAC verify, insert, enqueue": this is the first
 * step of it, as the library itself does it (`webhooks.validate`): base64 HMAC-SHA256 of
 * the raw body under the app's secret, compared in constant time, and the five headers a
 * delivery cannot be handled without.
 *
 * Refusals are thrown as the library throws them, so a caller cannot mistake one for a
 * delivery: 401 for a signature that does not match, 400 for a request that is not a
 * webhook at all, 405 for anything but a POST. No secret configured verifies nothing, and
 * is refused rather than checked against an empty key -- which any sender could sign.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifiedWebhook {
  /** `X-Shopify-Shop-Domain`. */
  shop: string;
  /** `X-Shopify-Topic`, as Shopify spells it: `products/update`. */
  topic: string;
  /** `X-Shopify-Webhook-Id`: the same for every retry of one delivery. */
  webhookId: string;
  apiVersion: string;
  payload: unknown;
}

const HEADERS = {
  hmac: "x-shopify-hmac-sha256",
  topic: "x-shopify-topic",
  shop: "x-shopify-shop-domain",
  apiVersion: "x-shopify-api-version",
  webhookId: "x-shopify-webhook-id",
} as const;

/** The signature Shopify sends for `rawBody`: base64 HMAC-SHA256 under the app's secret. */
export function webhookSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export async function verifyWebhook(
  request: Request,
  secret: string = process.env.SHOPIFY_API_SECRET ?? "",
): Promise<VerifiedWebhook> {
  if (request.method !== "POST") throw new Response(undefined, { status: 405, statusText: "Method not allowed" });

  const rawBody = await request.text();
  const hmac = request.headers.get(HEADERS.hmac);
  if (!rawBody || !hmac) throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  if (!secret || !sameSignature(hmac, webhookSignature(rawBody, secret))) {
    throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
  }

  const topic = request.headers.get(HEADERS.topic);
  const shop = request.headers.get(HEADERS.shop);
  const apiVersion = request.headers.get(HEADERS.apiVersion);
  const webhookId = request.headers.get(HEADERS.webhookId);
  if (!topic || !shop || !apiVersion || !webhookId) throw new Response(undefined, { status: 400, statusText: "Bad Request" });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }
  return { shop, topic, webhookId, apiVersion, payload };
}

/**
 * Constant-time, over the header exactly as sent. Not over its base64-decoded bytes: Node's
 * decoder skips characters that are not base64, so a signature with anything appended
 * would decode to the right bytes and pass. A length mismatch is a mismatch, not a throw.
 */
function sameSignature(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
