#!/usr/bin/env node
/**
 * Publishes every product to the Online Store sales channel.
 *
 * `productSet` creates products unpublished, so seeded catalogues exist in admin
 * but never appear on the storefront. This backfills the publication.
 *
 * Uses a bulk mutation for the same reason the seeder does: a thousand
 * publishablePublish calls would cost real rate-limit budget, and bulk operations
 * cost none.
 *
 *   node scripts/publish-products.mjs
 */

import { PrismaClient } from "@prisma/client";

const API_VERSION = "2026-07";

async function gql(shop, token, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}

async function main() {
  const prisma = new PrismaClient();
  const session = await prisma.session.findFirst();
  await prisma.$disconnect();
  if (!session) throw new Error("No session. Open the app in your store first.");

  const { shop, accessToken } = session;

  const pubs = await gql(shop, accessToken, `
    { publications(first: 20) { nodes { id name } } }
  `);
  const online = pubs.publications.nodes.find((p) => /online store/i.test(p.name));
  if (!online) throw new Error(`No Online Store publication. Found: ${pubs.publications.nodes.map((p) => p.name).join(", ")}`);
  console.log(`Publishing to: ${online.name}`);

  // Page through every product id.
  const ids = [];
  let cursor = null;
  for (;;) {
    const page = await gql(shop, accessToken, `
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id publishedOnCurrentPublication }
        }
      }
    `, { cursor });
    for (const node of page.products.nodes) {
      if (!node.publishedOnCurrentPublication) ids.push(node.id);
    }
    if (!page.products.pageInfo.hasNextPage) break;
    cursor = page.products.pageInfo.endCursor;
  }

  console.log(`  ${ids.length} products need publishing`);
  if (ids.length === 0) return;

  const jsonl = ids
    .map((id) => JSON.stringify({ id, input: [{ publicationId: online.id }] }))
    .join("\n") + "\n";

  const staged = await gql(shop, accessToken, `
    mutation {
      stagedUploadsCreate(input: [{
        resource: BULK_MUTATION_VARIABLES, filename: "publish.jsonl",
        mimeType: "text/jsonl", httpMethod: POST
      }]) {
        stagedTargets { url parameters { name value } }
        userErrors { message }
      }
    }
  `);
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "publish.jsonl");
  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) throw new Error(`Upload failed: ${upload.status}`);
  const key = target.parameters.find((p) => p.name === "key").value;

  const submitted = await gql(shop, accessToken, `
    mutation call($mutation: String!, $path: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
        bulkOperation { id status }
        userErrors { message }
      }
    }
  `, {
    mutation: `
      mutation call($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable { availablePublicationsCount { count } }
          userErrors { field message }
        }
      }
    `,
    path: key,
  });

  const errs = submitted.bulkOperationRunMutation.userErrors;
  if (errs?.length) throw new Error(errs.map((e) => e.message).join("; "));
  console.log(`  submitted: ${submitted.bulkOperationRunMutation.bulkOperation.id}`);

  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const { currentBulkOperation: op } = await gql(shop, accessToken, `
      { currentBulkOperation(type: MUTATION) { status objectCount errorCode } }
    `);
    if (!op) continue;
    process.stdout.write(`\r  ${op.status} — ${op.objectCount ?? 0}   `);
    if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(op.status)) {
      console.log(`\n  finished: ${op.status}`);
      return;
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
