#!/usr/bin/env node
/**
 * Seeds a development store with a perf catalogue.
 *
 * The shapes come from `app/lib/seed/catalogue.ts`, which is pure and tested. This file
 * does nothing but upload them — because the shapes are what every perf number depends on
 * and a seeding script that runs without erroring looks like it worked whether or not the
 * catalogue it produced means anything.
 *
 *   npx tsx scripts/seed-store.ts 2000 --variants 50   # ~100K variants
 *   npx tsx scripts/seed-store.ts --max-variant-product
 *   npx tsx scripts/seed-store.ts --markets
 *
 * **Idempotent.** Handles are derived from the index, and existing ones are skipped, so a
 * re-run tops up rather than duplicating. Without that a "100K store" quietly becomes a
 * 400K one after three runs, and every perf number taken from it is wrong in a direction
 * nobody notices.
 *
 * **Runtime.** Bulk mutations are FIFO-queued per shop and Shopify gives no ETA. In
 * practice 2,000 products of ~50 variants takes 20-40 minutes; the 2,048-variant product
 * alone takes a few minutes. Uses `bulkOperationRunMutation` because individual mutations
 * would cost ~100 rate-limit points each against a bucket restoring 50/second — over half
 * an hour of pure waiting for the same work.
 */

import prisma from "../app/db.server";
import { adminClientForShop } from "../app/services/admin-client.server";
import {
  buildCatalogue,
  buildMaxVariantProduct,
  marketPriceLists,
  type SeedProduct,
} from "../app/lib/seed/catalogue";
import type { AdminClient } from "../app/lib/execution/sync-executor";

const PRODUCT_SET = `#graphql
  mutation SeedProductSet($input: ProductSetInput!) {
    productSet(input: $input) {
      product { id }
      userErrors { field message }
    }
  }
`;

/** Existing handles, so a re-run tops up rather than duplicating. */
async function existingHandles(client: AdminClient): Promise<Set<string>> {
  const handles = new Set<string>();
  let cursor: string | null = null;

  do {
    const response: { data?: { products?: { nodes?: Array<{ handle: string }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } } =
      await client.request(
        `#graphql
          query SeedExisting($cursor: String) {
            products(first: 250, after: $cursor, query: "handle:anchor-perf-*") {
              nodes { handle }
              pageInfo { hasNextPage endCursor }
            }
          }
        `,
        { cursor },
      );

    for (const node of response.data?.products?.nodes ?? []) handles.add(node.handle);
    const page = response.data?.products?.pageInfo;
    cursor = page?.hasNextPage ? (page.endCursor ?? null) : null;
  } while (cursor);

  return handles;
}

/** One product as the bulk mutation's JSONL line. */
function toInput(product: SeedProduct): string {
  const optionNames = [...new Set(product.variants.flatMap((v) => v.optionValues.map((o) => o.optionName)))];

  return JSON.stringify({
    input: {
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      status: product.status,
      productOptions: optionNames.map((name) => ({
        name,
        values: [
          ...new Set(
            product.variants.flatMap((v) =>
              v.optionValues.filter((o) => o.optionName === name).map((o) => ({ name: o.name })),
            ).map((o) => o.name),
          ),
        ].map((name) => ({ name })),
      })),
      variants: product.variants.map((variant) => ({
        optionValues: variant.optionValues,
        price: variant.price,
        ...(variant.compareAtPrice ? { compareAtPrice: variant.compareAtPrice } : {}),
        sku: variant.sku,
        ...(variant.barcode ? { barcode: variant.barcode } : {}),
        ...(variant.cost ? { inventoryItem: { cost: variant.cost } } : {}),
      })),
    },
  });
}

async function upload(client: AdminClient, products: SeedProduct[]): Promise<void> {
  if (products.length === 0) {
    console.log("  nothing to create — every handle already exists");
    return;
  }

  const jsonl = `${products.map(toInput).join("\n")}\n`;
  console.log(`  payload: ${products.length} products, ${(jsonl.length / 1024).toFixed(0)} KB`);

  const staged = await client.request<{
    stagedUploadsCreate?: {
      stagedTargets?: Array<{ url: string; parameters: Array<{ name: string; value: string }> }>;
      userErrors?: Array<{ message?: string }>;
    };
  }>(
    `#graphql
      mutation SeedStagedUpload {
        stagedUploadsCreate(input: [{
          resource: BULK_MUTATION_VARIABLES,
          filename: "seed.jsonl",
          mimeType: "text/jsonl",
          httpMethod: POST
        }]) {
          stagedTargets { url parameters { name value } }
          userErrors { message }
        }
      }
    `,
    {},
  );

  const errors = staged.data?.stagedUploadsCreate?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error("Shopify returned no staged upload target");

  // Parameter order matters to the storage backend, and the file field must come last.
  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "seed.jsonl");

  const response = await fetch(target.url, { method: "POST", body: form });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);

  const key = target.parameters.find((p) => p.name === "key")?.value;
  console.log("  uploaded");

  const submitted = await client.request<{
    bulkOperationRunMutation?: {
      bulkOperation?: { id: string };
      userErrors?: Array<{ message?: string }>;
    };
  }>(
    `#graphql
      mutation SeedBulkRun($mutation: String!, $path: String!) {
        bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
          bulkOperation { id status }
          userErrors { field message }
        }
      }
    `,
    { mutation: PRODUCT_SET, path: key },
  );

  const submitErrors = submitted.data?.bulkOperationRunMutation?.userErrors ?? [];
  if (submitErrors.length) throw new Error(submitErrors.map((e) => e.message).join("; "));

  console.log(`  submitted: ${submitted.data?.bulkOperationRunMutation?.bulkOperation?.id}`);
  await poll(client);
}

async function poll(client: AdminClient): Promise<void> {
  // Bulk mutations are FIFO-queued per shop and Shopify gives no ETA, so this waits
  // rather than estimating. Twenty minutes of polling is cheaper than a script that
  // returns before the work is done and leaves somebody to guess whether it worked.
  for (let attempt = 0; attempt < 480; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const status = await client.request<{
      currentBulkOperation?: { status: string; objectCount?: string; errorCode?: string | null };
    }>(
      `#graphql
        query SeedBulkStatus {
          currentBulkOperation(type: MUTATION) { id status objectCount errorCode }
        }
      `,
      {},
    );

    const operation = status.data?.currentBulkOperation;
    if (!operation) continue;

    process.stdout.write(`\r  ${operation.status} — ${operation.objectCount ?? 0} objects   `);

    if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(operation.status)) {
      console.log(
        `\n  finished: ${operation.status}${operation.errorCode ? ` (${operation.errorCode})` : ""}`,
      );
      return;
    }
  }

  console.log("\n  still running — check the Dev Dashboard");
}

async function seedMarkets(): Promise<void> {
  console.log("Markets: this creates price lists only; the markets themselves are made in admin.");

  for (const list of marketPriceLists()) {
    console.log(
      `  ${list.name} (${list.currency}) — ` +
        (list.adjustmentBps === null
          ? `fixed prices, ${list.fixedOverrides} overrides`
          : `${(list.adjustmentBps / 100).toFixed(0)}% against base`),
    );
  }

  console.log(
    "\nCreate these in Settings → Markets, then run the app's market sync. " +
      "Creating them here would need a market id per list, and a market is a commercial " +
      "decision rather than test data — a script that invented four markets in somebody's " +
      "store would be the wrong kind of helpful.",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 2_000);
  const variants = Number(args[args.indexOf("--variants") + 1] ?? 50);

  const shop = await prisma.shop.findFirstOrThrow({ select: { domain: true } });
  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error(`No usable session for ${shop.domain}. Open the app first.`);

  if (args.includes("--markets")) {
    await seedMarkets();
    return;
  }

  console.log(`Reading existing handles from ${shop.domain}…`);
  const existing = await existingHandles(client);
  console.log(`  ${existing.size} already there`);

  if (args.includes("--max-variant-product")) {
    const product = buildMaxVariantProduct();
    console.log(`The 2,048-variant product: ${product.title}`);
    await upload(client, existing.has(product.handle) ? [] : [product]);
    return;
  }

  const catalogue = buildCatalogue({ products: count, variantsPerProduct: variants });
  const total = catalogue.reduce((sum, product) => sum + product.variants.length, 0);
  console.log(`Generated ${catalogue.length} products, ${total} variants`);

  await upload(client, catalogue.filter((product) => !existing.has(product.handle)));
}

main()
  .catch((error) => {
    console.error("FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
