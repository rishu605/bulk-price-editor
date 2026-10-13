#!/usr/bin/env tsx
/**
 * Who pressed Apply and Revert, through the real campaign page (#912).
 *
 * Posts the campaign page's own Apply and Revert to a running app -- a dev preview's local
 * server -- with a session token signed as staff user 1, the way App Bridge sends one. The
 * page authenticates it, runs the campaign, and the audit log must credit staff user 1 with
 * every move, not "system" (which the page shows as the Scheduler).
 *
 * Needs SHOPIFY_API_KEY and SHOPIFY_API_SECRET in the environment (to sign the token) and
 * the app's URL:
 *
 *   APP_URL=http://localhost:58471 npx tsx scripts/test-page-actor.ts --shop boltify-apps.myshopify.com [--hold 90]
 */

import { createHmac, randomUUID } from "node:crypto";

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";
import { captureBaselines } from "../app/services/baselines.server";
import { createCampaign } from "../app/services/campaigns/model.server";

const TAG = "anchor-page-actor-test";
const STAFF = "1";
let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

type Client = NonNullable<Awaited<ReturnType<typeof adminClientForShop>>>;

async function main() {
  const appUrl = process.env.APP_URL;
  const key = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!appUrl || !key || !secret) throw new Error("APP_URL, SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required");

  const installed = await prisma.shop.findMany({ where: { uninstalledAt: null }, select: { domain: true } });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error("No usable session — open the app in the store first");

  for (const productGid of await probesFromEarlierRuns(client)) await deleteProduct(client, productGid);
  const product = await createProduct(client);
  await prisma.variantIndex.createMany({
    data: [{ shopId: shop.id, variantGid: product.variantGid, productGid: product.productGid, title: product.title, price: 10000n, currency: "USD", status: "ACTIVE" as const, tags: [TAG] }],
    skipDuplicates: true,
  });
  await prisma.priceSurfaceEntry.createMany({
    data: [{ shopId: shop.id, variantGid: product.variantGid, surfaceKind: "BASE" as const, priceListGid: "", currency: "USD", livePrice: 10000n }],
    skipDuplicates: true,
  });
  await captureBaselines(shop.id, { variantGids: [product.variantGid], source: "INSTALL_CAPTURE" });

  const campaign = await createCampaign(shop.id, {
    name: `Page actor test ${Date.now()}`,
    priority: 960,
    rule: { kind: "percent-change", percent: -20 },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
    ast: { groups: [{ conditions: [{ field: "tag", value: TAG }] }] },
    schedule: { kind: "manual" },
  });
  const start = new Date(Date.now() - 1000);

  try {
    const press = async (intent: string) => {
      const body = new URLSearchParams({ intent, confirmation: "apply" });
      const response = await fetch(`${appUrl}/app/campaigns/${campaign.id}.data`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken(shop.domain, key, secret)}`,
          "Content-Type": "application/x-www-form-urlencoded",
          // The library answers a self-identified bot -- Node's own "node" included -- with 410.
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        },
        body,
      });
      console.log(`      ${intent}: HTTP ${response.status}`);
      return response.status;
    };

    console.log(`\npressing Apply and Revert on ${appUrl} as staff user ${STAFF}`);
    check("Apply accepted", await press("apply"), 200);
    const hold = Number(process.argv[process.argv.indexOf("--hold") + 1]);
    if (process.argv.includes("--hold") && hold > 0) {
      console.log(`      holding ${hold}s: /app/campaigns/${campaign.id}`);
      await new Promise((r) => setTimeout(r, hold * 1000));
    }
    check("Revert accepted", await press("revert"), 200);

    const moves = await prisma.auditLogEntry.findMany({
      where: { shopId: shop.id, entityId: campaign.id, action: "campaign.transition", createdAt: { gte: start } },
      orderBy: { createdAt: "asc" },
    });
    for (const move of moves) {
      const from = (move.before as { status?: string } | null)?.status;
      const to = (move.after as { status?: string } | null)?.status;
      console.log(`      ${move.actor}: ${from} → ${to}`);
    }
    check("moves recorded", moves.length, 4);
    check("every move credited to the staff user who pressed it", moves.every((move) => move.actor === `staff:${STAFF}`), true);
  } finally {
    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.baseline.deleteMany({ where: { shopId: shop.id, variantGid: product.variantGid } });
    await prisma.priceSurfaceEntry.deleteMany({ where: { shopId: shop.id, variantGid: product.variantGid } });
    await prisma.variantIndex.deleteMany({ where: { shopId: shop.id, variantGid: product.variantGid } });
    await deleteProduct(client, product.productGid).catch(() => {});
    console.log("\ncleaned up");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

/** An App Bridge session token for staff user `STAFF`: HS256 over the app's secret. */
function sessionToken(shop: string, key: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: key,
    sub: STAFF,
    exp: now + 60,
    nbf: now - 5,
    iat: now,
    jti: randomUUID(),
    sid: randomUUID(),
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function probesFromEarlierRuns(client: Client): Promise<string[]> {
  const result = (await client.request(`query($q: String!) { products(first: 50, query: $q) { nodes { id } } }`, {
    q: `tag:${TAG}`,
  })) as { data: { products: { nodes: Array<{ id: string }> } } };
  return result.data.products.nodes.map((node) => node.id);
}

async function createProduct(client: Client) {
  const title = `Page actor probe ${Date.now()}`;
  const result = (await client.request(
    `mutation Create($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    {
      input: {
        title,
        status: "ACTIVE",
        tags: [TAG],
        productOptions: [{ name: "Size", values: [{ name: "M" }] }],
        variants: [{ optionValues: [{ optionName: "Size", name: "M" }], price: "100.00" }],
      },
    },
  )) as { data: { productSet: { product: { id: string; variants: { nodes: Array<{ id: string }> } } } } };
  return {
    title,
    productGid: result.data.productSet.product.id,
    variantGid: result.data.productSet.product.variants.nodes[0].id,
  };
}

async function deleteProduct(client: Client, productGid: string) {
  await client.request(
    `mutation D($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId } }`,
    { input: { id: productGid } },
  );
}

main()
  .catch((error) => {
    console.error("\nERROR:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
