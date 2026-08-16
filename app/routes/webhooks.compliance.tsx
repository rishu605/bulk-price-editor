/**
 * The three mandatory GDPR compliance webhooks, on one endpoint.
 *
 * One route switching on topic rather than three routes: fewer places to get HMAC
 * verification wrong, and the three handlers share most of their reasoning.
 *
 * Anchor stores product and pricing data, plus staff attribution on audit entries.
 * It holds **no customer PII at all**, which makes two of these three a documented
 * acknowledgement rather than a data operation. Answering them correctly anyway is
 * required for a public app, and saying "we hold none" is a real answer.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Shopify requires JSON; rejecting anything else before parsing keeps malformed
  // or probing requests away from the HMAC check entirely.
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return new Response("Content-Type must be application/json", { status: 400 });
  }

  // authenticate.webhook verifies the HMAC over the raw body and throws on mismatch.
  const { shop, topic } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // We store no customer-specific data, so there is nothing to hand over.
      // Acknowledging is the complete and honest response.
      console.log(`[compliance] ${topic} for ${shop}: no customer data held`);
      break;

    case "CUSTOMERS_REDACT":
      // Nothing to erase, for the same reason. Logged so the acknowledgement is
      // auditable if a merchant ever asks what happened to a request.
      console.log(`[compliance] ${topic} for ${shop}: no customer data to redact`);
      break;

    case "SHOP_REDACT": {
      // This one is real. Everything we hold is keyed to the shop, and the cascade
      // rules on Shop remove variants, baselines, campaigns, ledger rows and audit
      // entries with it.
      const deleted = await prisma.shop.deleteMany({ where: { domain: shop } });
      await prisma.session.deleteMany({ where: { shop } });
      console.log(`[compliance] ${topic} for ${shop}: purged ${deleted.count} shop record(s)`);
      break;
    }

    default:
      // An unexpected topic on this endpoint means the app config and this handler
      // have drifted apart. Surface it rather than returning a silent 200.
      console.error(`[compliance] Unhandled topic ${topic} for ${shop}`);
      return new Response(`Unhandled topic ${topic}`, { status: 422 });
  }

  return new Response();
};
