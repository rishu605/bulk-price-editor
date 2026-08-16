#!/usr/bin/env node
/**
 * Seeds a development store with realistic test products.
 *
 * Shape matters more than count. A flat thousand identical variants would pass
 * tests that a real catalogue fails, so this deliberately includes the awkward
 * cases that break naive pricing code (task P0.7):
 *
 *   - variants with NO cost, so cost-based guardrails have to skip rather than
 *     silently treat cost as zero
 *   - products with no compare-at, and some where compare-at is already BELOW the
 *     price, which is invalid for a strike-through (edge case E11)
 *   - prices spanning three orders of magnitude, including sub-major-unit amounts
 *     where charm rounding once produced a negative price
 *   - multi-variant products, since the write mutation is per-product
 *   - wide vendor / type / tag spread so filter performance is realistic
 *
 * Uses bulkOperationRunMutation: creating a thousand products through individual
 * mutations would cost ~100 rate-limit points each against a bucket that restores
 * 50/second, i.e. over half an hour of waiting. Bulk operations cost nothing.
 *
 *   node scripts/seed-store.mjs [count]
 */

import { PrismaClient } from "@prisma/client";

const COUNT = Number(process.argv[2] ?? 1000);
const API_VERSION = "2026-07";

const VENDORS = [
  "Northwind", "Aurora Supply", "Basalt Goods", "Cedar & Co", "Dovetail",
  "Ember Works", "Fjord Outfitters", "Granite Lane", "Harbourlight", "Ironwood",
];
const TYPES = [
  "Snowboard", "Jacket", "Gloves", "Goggles", "Boots", "Helmet", "Wax", "Backpack",
];
const TAGS = [
  "sale", "new", "clearance", "seasonal", "bestseller", "limited", "bundle",
  "outlet", "premium", "core",
];
const ADJECTIVES = [
  "Alpine", "Arctic", "Basecamp", "Cascade", "Drift", "Everest", "Frost",
  "Glacier", "Summit", "Tundra", "Vertex", "Whiteout",
];

let seed = 20260817;
/** Deterministic PRNG, so a re-run produces the same catalogue. */
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + random() * (max - min);

function priceFor(index) {
  // Three bands, including sub-major-unit prices where charm rounding once
  // produced a negative value.
  if (index % 23 === 0) return between(0.35, 0.99);
  if (index % 7 === 0) return between(200, 2000);
  return between(5, 180);
}

function buildProduct(index) {
  const type = pick(TYPES);
  const title = `${pick(ADJECTIVES)} ${type} ${index}`;
  const variantCount = index % 11 === 0 ? 4 : index % 3 === 0 ? 2 : 1;

  const tags = [pick(TAGS)];
  if (random() > 0.6) tags.push(pick(TAGS));

  const variants = [];
  for (let v = 0; v < variantCount; v++) {
    const price = Number(priceFor(index + v).toFixed(2));

    // A third have no compare-at; a few have one BELOW price, which is invalid
    // for a strike-through and must be caught rather than written (E11).
    let compareAtPrice;
    const roll = random();
    if (roll > 0.66) compareAtPrice = Number((price * between(1.1, 1.6)).toFixed(2));
    else if (roll > 0.6) compareAtPrice = Number((price * 0.8).toFixed(2));

    variants.push({
      optionValues: [{ optionName: "Size", name: ["S", "M", "L", "XL"][v] ?? `V${v}` }],
      price: price.toFixed(2),
      ...(compareAtPrice ? { compareAtPrice: compareAtPrice.toFixed(2) } : {}),
      // A quarter have no cost at all -- the case that makes cost-based guardrails
      // skip instead of pricing at zero.
      ...(random() > 0.25
        ? { inventoryItem: { cost: (price * between(0.3, 0.7)).toFixed(2) } }
        : {}),
    });
  }

  return {
    input: {
      title,
      vendor: pick(VENDORS),
      productType: type,
      tags,
      status: index % 29 === 0 ? "DRAFT" : "ACTIVE",
      productOptions: [
        { name: "Size", values: variants.map((v) => ({ name: v.optionValues[0].name })) },
      ],
      variants,
    },
  };
}

const MUTATION = `
  mutation call($input: ProductCreateInput!) {
    productCreate(product: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

async function gql(shop, token, query, variables) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}

async function main() {
  const prisma = new PrismaClient();
  const session = await prisma.session.findFirst({ where: { accessToken: { not: "" } } });
  await prisma.$disconnect();

  if (!session) throw new Error("No session found. Open the app in your store first.");
  const { shop, accessToken } = session;
  console.log(`Seeding ${COUNT} products into ${shop}`);

  // 1. Build the JSONL payload, one line per product.
  const lines = [];
  for (let i = 1; i <= COUNT; i++) lines.push(JSON.stringify(buildProduct(i)));
  const jsonl = lines.join("\n") + "\n";
  console.log(`  payload: ${lines.length} lines, ${(jsonl.length / 1024).toFixed(0)} KB`);

  // 2. Stage an upload target.
  const staged = await gql(shop, accessToken, `
    mutation {
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
  `, {});

  const errs = staged.stagedUploadsCreate.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => e.message).join("; "));
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  // 3. Upload it. Parameter order matters to the storage backend, and the file
  //    field must come last.
  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "seed.jsonl");

  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) throw new Error(`Upload failed: ${upload.status} ${await upload.text()}`);
  const key = target.parameters.find((p) => p.name === "key").value;
  console.log("  uploaded");

  // 4. Submit the bulk mutation.
  const submitted = await gql(shop, accessToken, `
    mutation call($mutation: String!, $path: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `, { mutation: MUTATION, path: key });

  const submitErrors = submitted.bulkOperationRunMutation.userErrors;
  if (submitErrors?.length) throw new Error(submitErrors.map((e) => e.message).join("; "));
  console.log(`  submitted: ${submitted.bulkOperationRunMutation.bulkOperation.id}`);

  // 5. Poll to completion. FIFO queueing means this is not instant.
  for (let attempt = 0; attempt < 240; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await gql(shop, accessToken, `
      query { currentBulkOperation(type: MUTATION) { id status objectCount errorCode url } }
    `, {});
    const op = status.currentBulkOperation;
    if (!op) continue;
    process.stdout.write(`\r  ${op.status} — ${op.objectCount ?? 0} objects   `);
    if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(op.status)) {
      console.log(`\n  finished: ${op.status}${op.errorCode ? ` (${op.errorCode})` : ""}`);
      if (op.url) console.log(`  results: ${op.url.slice(0, 80)}...`);
      return;
    }
  }
  console.log("\n  still running — check the Dev Dashboard for progress");
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
