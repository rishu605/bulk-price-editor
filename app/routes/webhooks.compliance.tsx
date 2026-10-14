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
import { logger } from "../lib/logging/logger";
import prisma from "../db.server";
import { forgetShopErrors } from "../services/error-report.server";
import { forgetShopDeliveries, recordedWebhook } from "../services/webhook-log.server";

export const action = recordedWebhook(async ({ request }: ActionFunctionArgs) => {
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
      logger.info("compliance webhook: no customer data held", { topic, shop });
      break;

    case "CUSTOMERS_REDACT":
      // Nothing to erase, for the same reason. Logged so the acknowledgement is
      // auditable if a merchant ever asks what happened to a request.
      logger.info("compliance webhook: no customer data to redact", { topic, shop });
      break;

    case "SHOP_REDACT": {
      // This one is real. Almost everything we hold is keyed to the shop, and the cascade
      // rules on Shop remove variants, baselines, campaigns, ledger rows, audit entries,
      // feedback, imports and the deliveries attributed to it along with it. Three
      // tables are not reached that way, and each is cleared here by name (#785):
      //
      // - `error_events` is SetNull, so a shop's failures outlived it, and the ones
      //   recorded before it was known never pointed at it at all. Both kinds can name
      //   the domain. Cleared first, while the shop's id still finds its own rows.
      // - `session` is Shopify's session storage, keyed by domain with no relation.
      // - `webhook_events` cascades only where a delivery found the shop; one recorded
      //   without it carries only the domain.
      //
      // This delivery's own record is written after this returns, and without the domain
      // (`recordedWebhook`). The log line below names the shop; logs roll over.
      const record = await prisma.shop.findUnique({ where: { domain: shop }, select: { id: true } });
      const errors = await forgetShopErrors(shop, record?.id ?? null);
      const deleted = await prisma.shop.deleteMany({ where: { domain: shop } });
      await prisma.session.deleteMany({ where: { shop } });
      const deliveries = await forgetShopDeliveries(shop);
      logger.info("compliance webhook: shop purged", { topic, shop, purged: deleted.count, errors, deliveries });
      break;
    }

    default:
      // An unexpected topic on this endpoint means the app config and this handler
      // have drifted apart. Surface it rather than returning a silent 200.
      logger.error("compliance webhook: unhandled topic", { topic, shop });
      return new Response(`Unhandled topic ${topic}`, { status: 422 });
  }

  return new Response();
});
