/**
 * Applying and removing a campaign's product tags.
 *
 * The tag kit is how a theme badges sale items without the app shipping a line of
 * theme code — which was a deliberate scope decision, not an omission. Theme-facing
 * code risks the Built-for-Shopify performance budget and drags the app into theme
 * support forever; a tag is an integration point any theme can key off and nobody has
 * to maintain.
 *
 * Tags go through the same discipline as prices, for the same reason:
 *
 *   Ledger before write. A tag added with no record is a tag a revert cannot remove,
 *   and the merchant is left with "SALE" badges on full-price products with nothing to
 *   explain them.
 *
 *   Read back and verify. `tagsAdd` reports success for a mutation that did nothing
 *   useful often enough that trusting it is how badges go missing on a live sale.
 *
 * The one asymmetry with prices: ownership. A price is simply set, but a tag might
 * already have been there, and taking back something the merchant put there is worse
 * than never adding it. So the delta is computed against the product's live tags
 * immediately before writing, and only the delta is ever removed.
 */

import prisma from "../../db.server";
import { classifyFailure } from "../../lib/execution/classify";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { normaliseTag, planTagRemoval, planTagsFor } from "../../lib/tags/plan";
import { isThrottledError, withRetry } from "../../lib/shopify/budget";

export const PRODUCT_TAGS_QUERY = `#graphql
  query AnchorProductTags($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id tags }
    }
  }
`;

export const TAGS_ADD = `#graphql
  mutation AnchorTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

export const TAGS_REMOVE = `#graphql
  mutation AnchorTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

export interface TagOutcome {
  products: number;
  tagged: number;
  failed: number;
  /** Tags asked for that the product already had, and were left alone. */
  leftAlone: number;
  messages: string[];
}

interface TagsResponse {
  tagsAdd?: { userErrors?: Array<{ message: string }> };
  tagsRemove?: { userErrors?: Array<{ message: string }> };
}

interface NodesTagsResponse {
  nodes?: Array<{ id: string; tags?: string[] } | null>;
}

/** Reads live tags for a set of products, in batches Shopify will accept. */
async function liveTags(
  client: AdminClient,
  productGids: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const BATCH = 50;

  for (let i = 0; i < productGids.length; i += BATCH) {
    const ids = productGids.slice(i, i + BATCH);
    const response = await withRetry(
      () => client.request<NodesTagsResponse>(PRODUCT_TAGS_QUERY, { ids }),
      isThrottledError,
    );
    for (const node of response.data?.nodes ?? []) {
      if (node?.id) out.set(node.id, node.tags ?? []);
    }
  }

  return out;
}

/**
 * Applies the campaign's tag kit to every product it priced.
 *
 * Live tags are read immediately before writing rather than taken from the mirror.
 * The mirror is a cache and can lag a merchant's own tag edit by a webhook; being
 * wrong here does not mean a stale display, it means recording a merchant's tag as
 * ours and deleting it on revert.
 */
export async function applyCampaignTags(
  shopId: string,
  campaignId: string,
  runId: string,
  productGids: string[],
  tagKit: string[],
  client: AdminClient,
): Promise<TagOutcome> {
  const kit = tagKit.map((t) => t.trim()).filter(Boolean);
  if (kit.length === 0 || productGids.length === 0) {
    return { products: 0, tagged: 0, failed: 0, leftAlone: 0, messages: [] };
  }

  const current = await liveTags(client, productGids);
  const messages: string[] = [];
  let tagged = 0;
  let failed = 0;
  let leftAlone = 0;

  for (const productGid of productGids) {
    const plan = planTagsFor(productGid, kit, current.get(productGid) ?? []);
    leftAlone += plan.alreadyPresent.length;

    // Ledgered even when there is nothing to add. "We looked and everything was
    // already there" is a different fact from "we never got to this product", and a
    // revert that cannot tell them apart is a revert that guesses.
    await prisma.tagChange.upsert({
      where: { runId_productGid: { runId, productGid } },
      create: {
        shopId,
        runId,
        campaignId,
        productGid,
        addedTags: plan.toAdd,
        alreadyPresent: plan.alreadyPresent,
        status: plan.toAdd.length === 0 ? "SKIPPED" : "PENDING",
        appliedAt: plan.toAdd.length === 0 ? new Date() : null,
      },
      update: {
        addedTags: plan.toAdd,
        alreadyPresent: plan.alreadyPresent,
        status: plan.toAdd.length === 0 ? "SKIPPED" : "PENDING",
      },
    });

    if (plan.toAdd.length === 0) continue;

    try {
      const response = await withRetry(
        () => client.request<TagsResponse>(TAGS_ADD, { id: productGid, tags: plan.toAdd }),
        isThrottledError,
      );

      const errors = response.data?.tagsAdd?.userErrors ?? [];
      if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));

      await prisma.tagChange.update({
        where: { runId_productGid: { runId, productGid } },
        data: { status: "APPLIED", appliedAt: new Date() },
      });
      tagged++;
    } catch (error) {
      const classified = classifyFailure(error);
      failed++;
      await prisma.tagChange.update({
        where: { runId_productGid: { runId, productGid } },
        data: {
          status: "FAILED",
          failureReason: `${classified.message} (Shopify said: ${
            error instanceof Error ? error.message : String(error)
          })`,
        },
      });
      if (messages.length < 3) messages.push(classified.message);
    }
  }

  // Read back what actually landed. A tag the theme keys its badge off is not
  // something to take Shopify's word for.
  const verified = await verifyTags(client, runId);

  return {
    products: productGids.length,
    tagged: verified,
    failed: failed + (tagged - verified),
    leftAlone,
    messages,
  };
}

/** Confirms applied tags are really on the products, and marks the ledger. */
async function verifyTags(client: AdminClient, runId: string): Promise<number> {
  const applied = await prisma.tagChange.findMany({
    where: { runId, status: "APPLIED" },
    select: { productGid: true, addedTags: true },
  });
  if (applied.length === 0) return 0;

  const live = await liveTags(client, applied.map((row) => row.productGid));
  let verified = 0;

  for (const row of applied) {
    const have = new Set((live.get(row.productGid) ?? []).map(normaliseTag));
    const missing = row.addedTags.filter((tag) => !have.has(normaliseTag(tag)));

    if (missing.length === 0) {
      await prisma.tagChange.updateMany({
        where: { runId, productGid: row.productGid },
        data: { status: "VERIFIED", verifiedAt: new Date() },
      });
      verified++;
    } else {
      await prisma.tagChange.updateMany({
        where: { runId, productGid: row.productGid },
        data: {
          status: "FAILED",
          failureReason: `Applied but not found on the product afterwards: ${missing.join(", ")}.`,
        },
      });
    }
  }

  return verified;
}

/**
 * Removes every tag this campaign added, across all of its runs.
 *
 * Driven entirely by the ledger, never by the current tag kit. A merchant who edited
 * the kit mid-campaign would otherwise strand the old tags on the storefront — the
 * badge stays, the sale is over, and nothing in the app admits it.
 */
export async function removeCampaignTags(
  shopId: string,
  campaignId: string,
  client: AdminClient,
): Promise<TagOutcome> {
  const ledgered = await prisma.tagChange.findMany({
    where: { shopId, campaignId, status: { in: ["APPLIED", "VERIFIED"] } },
    select: { productGid: true, addedTags: true },
  });
  if (ledgered.length === 0) {
    return { products: 0, tagged: 0, failed: 0, leftAlone: 0, messages: [] };
  }

  const removals = planTagRemoval(ledgered, await tagsOwedByOthers(shopId, campaignId));
  const messages: string[] = [];
  let removed = 0;
  let failed = 0;

  for (const { productGid, toRemove } of removals) {
    try {
      const response = await withRetry(
        () => client.request<TagsResponse>(TAGS_REMOVE, { id: productGid, tags: toRemove }),
        isThrottledError,
      );
      const errors = response.data?.tagsRemove?.userErrors ?? [];
      if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));

      await prisma.tagChange.updateMany({
        where: { shopId, campaignId, productGid },
        data: { status: "REVERTED", failureReason: null },
      });
      removed++;
    } catch (error) {
      const classified = classifyFailure(error);
      failed++;
      await prisma.tagChange.updateMany({
        where: { shopId, campaignId, productGid },
        data: { failureReason: `Could not remove tags: ${classified.message}` },
      });
      if (messages.length < 3) messages.push(classified.message);
    }
  }

  return { products: removals.length, tagged: removed, failed, leftAlone: 0, messages };
}

/**
 * Tags other still-running campaigns have on each product.
 *
 * Two overlapping sales both tagging "SALE" is ordinary, and ending one must not strip
 * the badge from the other. Without this, the first campaign to finish silently
 * un-badges the second.
 */
async function tagsOwedByOthers(
  shopId: string,
  campaignId: string,
): Promise<Map<string, Set<string>>> {
  const rows = await prisma.tagChange.findMany({
    where: {
      shopId,
      campaignId: { not: campaignId },
      status: { in: ["APPLIED", "VERIFIED"] },
      run: { campaign: { status: { in: ["ACTIVE", "APPLYING", "PARTIAL"] } } },
    },
    select: { productGid: true, addedTags: true },
  });

  const owed = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = owed.get(row.productGid) ?? new Set<string>();
    for (const tag of row.addedTags) set.add(normaliseTag(tag));
    owed.set(row.productGid, set);
  }
  return owed;
}
