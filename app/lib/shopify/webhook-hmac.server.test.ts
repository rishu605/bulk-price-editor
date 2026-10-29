/**
 * Verifying a products webhook from its raw body, as the library's `webhooks.validate`
 * does, without the session load `authenticate.webhook` adds (#811).
 */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyWebhook, webhookSignature } from "./webhook-hmac.server";

const SECRET = "the-app-secret";
const BODY = JSON.stringify({ id: 1, admin_graphql_api_id: "gid://shopify/Product/1" });

function request(
  body: string,
  headers: Record<string, string | undefined> = {},
  method = "POST",
): Request {
  const all: Record<string, string | undefined> = {
    "X-Shopify-Hmac-Sha256": webhookSignature(body, SECRET),
    "X-Shopify-Topic": "products/update",
    "X-Shopify-Shop-Domain": "shop.myshopify.com",
    "X-Shopify-API-Version": "2026-07",
    "X-Shopify-Webhook-Id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
    ...headers,
  };
  const defined = Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined)) as Record<string, string>;
  return new Request("https://example.invalid/webhooks/products", { method, headers: defined, ...(method === "POST" ? { body } : {}) });
}

async function refusal(promise: Promise<unknown>): Promise<number> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown, "a request that should have been refused was verified").toBeInstanceOf(Response);
  return (thrown as Response).status;
}

describe("verifying a webhook from its raw body", () => {
  it("signs as Shopify does: base64 HMAC-SHA256 of the raw body under the app's secret", () => {
    expect(webhookSignature(BODY, SECRET)).toBe(createHmac("sha256", SECRET).update(BODY, "utf8").digest("base64"));
  });

  it("accepts a correctly signed delivery and returns what the route needs", async () => {
    await expect(verifyWebhook(request(BODY), SECRET)).resolves.toEqual({
      shop: "shop.myshopify.com",
      topic: "products/update",
      webhookId: "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
      apiVersion: "2026-07",
      payload: JSON.parse(BODY),
    });
  });

  it("refuses a body that is not the one signed", async () => {
    const tampered = request(BODY.replace("1", "2"), { "X-Shopify-Hmac-Sha256": webhookSignature(BODY, SECRET) });
    expect(await refusal(verifyWebhook(tampered, SECRET))).toBe(401);
  });

  it("refuses a signature with anything appended, which a lenient base64 decode would accept", async () => {
    const padded = request(BODY, { "X-Shopify-Hmac-Sha256": `${webhookSignature(BODY, SECRET)}!!` });
    expect(await refusal(verifyWebhook(padded, SECRET))).toBe(401);
  });

  it("refuses everything when no secret is configured, rather than checking against an empty key", async () => {
    const signedWithNothing = request(BODY, { "X-Shopify-Hmac-Sha256": webhookSignature(BODY, "") });
    expect(await refusal(verifyWebhook(signedWithNothing, ""))).toBe(401);
  });

  it.each(["X-Shopify-Topic", "X-Shopify-Shop-Domain", "X-Shopify-API-Version", "X-Shopify-Webhook-Id"])(
    "refuses a signed request without %s, which no delivery lacks",
    async (header) => {
      expect(await refusal(verifyWebhook(request(BODY, { [header]: undefined }), SECRET))).toBe(400);
    },
  );

  it("refuses a request with no signature or no body as not a webhook", async () => {
    expect(await refusal(verifyWebhook(request(BODY, { "X-Shopify-Hmac-Sha256": undefined }), SECRET))).toBe(400);
    expect(await refusal(verifyWebhook(request(""), SECRET))).toBe(400);
  });

  it("refuses anything but a POST", async () => {
    expect(await refusal(verifyWebhook(request(BODY, {}, "GET"), SECRET))).toBe(405);
  });
});
