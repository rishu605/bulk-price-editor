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
 *   npx tsx scripts/seed-store.ts 2000 --location gid://shopify/Location/123  # with stock
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
  COLLECTIONS,
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

/**
 * The location seeded stock lands at, passed in rather than discovered.
 *
 * Inventory has to be attached to a location — there is no shop-wide quantity — and both
 * routes to finding one are closed. `locations` answers "Access denied for locations
 * field"; going the long way round through a variant's `inventoryLevels` answers
 * "Required access: `read_inventory`". Both were checked against the store rather than
 * assumed.
 *
 * Neither scope belongs in the manifest. D4 keeps the set to what the *product* uses, and
 * no feature reads a location or an inventory level — the mirror gets `inventoryQuantity`
 * from the product graph, which `read_products` covers. Adding a scope so a developer
 * tool could be more convenient would put an extra permission checkbox in front of every
 * merchant.
 *
 * So the id is pasted in by whoever runs this, from Settings → Locations in admin:
 *
 *   npx tsx scripts/seed-store.ts 2000 --variants 50 --location gid://shopify/Location/123
 *
 * Without it the catalogue seeds without stock, and every variant reads
 * `inventoryQuantity: null` — which means "not tracked" rather than "none", and makes
 * `inventoryMin` untestable. The script says so loudly rather than seeding quietly and
 * leaving somebody to discover it from a filter that matches nothing.
 */
function locationFrom(args: string[]): string | null {
  const flag = args.indexOf("--location");
  if (flag === -1) return null;

  const value = args[flag + 1];
  if (!value?.startsWith("gid://shopify/Location/")) {
    throw new Error(
      `--location wants a location gid, got ${value ?? "nothing"}. ` +
        "Settings → Locations in admin; the id is in the URL.",
    );
  }

  return value;
}

/**
 * Creates the perf collections if they are not already there, and maps handle to id.
 *
 * `productSet` takes collection *ids*, so this has to run before any product is uploaded.
 * Idempotent by handle for the same reason the products are: a re-run that made a second
 * "winter-2026" would leave the filter matching half of what it should, and a perf number
 * measured against half a collection is worse than no number.
 */
async function ensureCollections(client: AdminClient): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const { handle } of COLLECTIONS) {
    const found = await client.request<{ collectionByHandle?: { id: string } | null }>(
      `#graphql
        query SeedCollectionByHandle($handle: String!) {
          collectionByHandle(handle: $handle) { id }
        }
      `,
      { handle },
    );

    const existing = found.data?.collectionByHandle?.id;
    if (existing) {
      ids.set(handle, existing);
      continue;
    }

    const created = await client.request<{
      collectionCreate?: {
        collection?: { id: string } | null;
        userErrors?: Array<{ message?: string }>;
      };
    }>(
      `#graphql
        mutation SeedCollectionCreate($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { id }
            userErrors { field message }
          }
        }
      `,
      { input: { handle, title: handle.replace(/-/g, " ") } },
    );

    const error = created.data?.collectionCreate?.userErrors?.[0]?.message;
    if (error) {
      console.log(`  collection ${handle}: ${error}`);
      continue;
    }

    const id = created.data?.collectionCreate?.collection?.id;
    if (id) ids.set(handle, id);
  }

  return ids;
}

/** One product as the bulk mutation's JSONL line. */
function toInput(
  product: SeedProduct,
  collectionIds: Map<string, string>,
  locationId: string | null,
): string {
  const optionNames = [...new Set(product.variants.flatMap((v) => v.optionValues.map((o) => o.optionName)))];

  return JSON.stringify({
    input: {
      handle: product.handle,
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      status: product.status,
      // Silently dropping a collection we failed to create would leave the filter
      // matching fewer products than the generator says it should, which is exactly the
      // kind of discrepancy that makes a perf number quietly wrong.
      collections: product.collections
        .map((handle) => collectionIds.get(handle))
        .filter((id): id is string => Boolean(id)),
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
        // `tracked` is required alongside a quantity — an untracked item has no stock to
        // set, and Shopify rejects the pair rather than inferring it.
        ...(variant.cost || locationId
          ? {
              inventoryItem: {
                ...(variant.cost ? { cost: variant.cost } : {}),
                ...(locationId ? { tracked: true } : {}),
              },
            }
          : {}),
        ...(locationId
          ? {
              inventoryQuantities: [
                { locationId, name: "available", quantity: variant.inventoryQty },
              ],
            }
          : {}),
      })),
    },
  });
}

async function upload(
  client: AdminClient,
  products: SeedProduct[],
  collectionIds: Map<string, string>,
  locationId: string | null,
): Promise<void> {
  if (products.length === 0) {
    console.log("  nothing to create — every handle already exists");
    return;
  }

  const jsonl = `${products.map((product) => toInput(product, collectionIds, locationId)).join("\n")}\n`;
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
      currentBulkOperation?: {
        status: string;
        objectCount?: string;
        errorCode?: string | null;
        url?: string | null;
        partialDataUrl?: string | null;
      };
    }>(
      `#graphql
        query SeedBulkStatus {
          currentBulkOperation(type: MUTATION) {
            id status objectCount errorCode url partialDataUrl
          }
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
      await reportRowErrors(operation.url ?? operation.partialDataUrl ?? null);
      return;
    }
  }

  console.log("\n  still running — check the Dev Dashboard");
}

/**
 * Reads what the bulk mutation actually did, rather than trusting that it finished.
 *
 * `COMPLETED` means Shopify ran every line, not that any of them worked. Each line's
 * `userErrors` are in the result file and nowhere else — so a seed where every single
 * product was rejected printed `COMPLETED — 1 objects` and exited zero. It did exactly
 * that for the 2,048-variant product, and the failure was only visible by fetching this
 * file by hand afterwards.
 *
 * That is the same mistake the app itself is built not to make: a run is clean only when
 * its rows have been read back. A seeding script gets no exemption — it is the thing
 * every perf number is measured against.
 */
async function reportRowErrors(url: string | null): Promise<void> {
  if (!url) {
    console.log("  no result file — cannot confirm any row succeeded");
    return;
  }

  const body = await (await fetch(url)).text();
  const lines = body.split("\n").filter(Boolean);

  let created = 0;
  const messages = new Map<string, number>();

  for (const line of lines) {
    const parsed = JSON.parse(line) as {
      data?: { productSet?: { product?: { id?: string } | null; userErrors?: Array<{ message?: string }> } };
    };
    const payload = parsed.data?.productSet;

    if (payload?.product?.id) created++;

    // Counted by message rather than listed. One malformed input produces one error per
    // variant, so a single bad product yields two thousand identical lines — printing
    // them all buries the one line that says what to fix.
    for (const error of payload?.userErrors ?? []) {
      const message = error.message ?? "unknown";
      messages.set(message, (messages.get(message) ?? 0) + 1);
    }
  }

  console.log(`  created ${created}/${lines.length}`);

  if (messages.size === 0) return;

  console.log("  errors:");
  for (const [message, count] of [...messages.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count}× ${message}`);
  }

  // Non-zero exit, because a seed that created nothing must not look like a success to
  // whatever ran it.
  if (created === 0) process.exitCode = 1;
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
  const locationId = locationFrom(args);

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

  const collectionIds = await ensureCollections(client);
  console.log(`  ${collectionIds.size}/${COLLECTIONS.length} collections ready`);

  // Never silent. A run that seeded no stock looks identical to one that did, right up
  // until somebody reads an inventory-filter timing off a catalogue that has no
  // inventory.
  if (!locationId) {
    console.log(
      "  NO STOCK — pass --location gid://shopify/Location/… to seed inventory.\n" +
        "  Without it every variant reads as untracked and inventoryMin is untestable.",
    );
  }

  if (args.includes("--max-variant-product")) {
    const product = buildMaxVariantProduct();
    console.log(`The 2,048-variant product: ${product.title}`);
    await upload(client, existing.has(product.handle) ? [] : [product], collectionIds, locationId);
    return;
  }

  const catalogue = buildCatalogue({ products: count, variantsPerProduct: variants });
  const total = catalogue.reduce((sum, product) => sum + product.variants.length, 0);
  console.log(`Generated ${catalogue.length} products, ${total} variants`);

  await upload(
    client,
    catalogue.filter((product) => !existing.has(product.handle)),
    collectionIds,
    locationId,
  );
}

main()
  .catch((error) => {
    console.error("FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
