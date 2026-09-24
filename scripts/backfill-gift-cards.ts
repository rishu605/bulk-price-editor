/**
 * Marks the gift cards already sitting in the catalogue mirror.
 *
 * `variant_index.isGiftCard` arrived with a NOT NULL DEFAULT false, so every row written
 * before it reads "not a gift card" — including the gift cards. Until something corrects
 * them they stay inside every campaign's scope, which is the bug the column exists to
 * close: a 20% campaign turns $100 of store credit into $64.
 *
 * A full catalogue re-sync would fix it and costs half an hour on a 100K store. This asks
 * Shopify the narrow question instead — `products(query: "gift_card:true")` — which on
 * every real shop returns one product and a handful of variants.
 *
 * Run once per installed shop after the migration deploys:
 *
 *   npx tsx scripts/backfill-gift-cards.ts --shop dartmode-labs
 *   npx tsx scripts/backfill-gift-cards.ts --shop dartmode-labs --dry-run
 *
 * Idempotent: re-running it writes nothing the second time. It only ever sets the flag
 * to true — a product that stopped being a gift card is not a thing Shopify permits, and
 * clearing flags here would fight the sync paths that now set them.
 */

import prisma from "../app/db.server";
import { chooseShop, shopArg } from "../app/lib/seed/target-shop";
import { adminClientForShop } from "../app/services/admin-client.server";

const GIFT_CARD_PRODUCTS = `#graphql
  query AnchorGiftCardProducts($cursor: String) {
    products(first: 50, after: $cursor, query: "gift_card:true") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        isGiftCard
        variants(first: 100) {
          pageInfo { hasNextPage }
          nodes { id }
        }
      }
    }
  }
`;

interface GiftCardPage {
  products?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    nodes?: Array<{
      id: string;
      title?: string | null;
      isGiftCard?: boolean | null;
      variants?: {
        pageInfo?: { hasNextPage?: boolean } | null;
        nodes?: Array<{ id: string }> | null;
      } | null;
    }> | null;
  } | null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Name the store or be told which exist. This writes to a real mirror that real
  // campaigns scope from, so guessing is not on offer.
  const installed = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { domain: true },
  });
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: chooseShop(installed, shopArg(process.argv.slice(2))).domain },
  });

  const client = await adminClientForShop(shop.domain);
  if (!client) throw new Error(`No usable session for ${shop.domain}`);

  console.log(`shop: ${shop.domain}${dryRun ? "  (dry run)" : ""}\n`);

  const variantGids: string[] = [];
  let cursor: string | null = null;
  let truncated = 0;

  for (;;) {
    // `request` takes variables directly, not wrapped in `{ variables }` -- wrapping
    // them returns Shopify's unhelpful "provided invalid value".
    const body: { data?: GiftCardPage } = await client.request<GiftCardPage>(
      GIFT_CARD_PRODUCTS,
      { cursor },
    );
    const page = body.data?.products;

    for (const product of page?.nodes ?? []) {
      // Trust the field, not the search. `gift_card:true` is Shopify's index; the
      // boolean is the record. If they ever disagree, believe the record.
      if (product.isGiftCard !== true) continue;

      const gids = (product.variants?.nodes ?? []).map((v) => v.id);
      variantGids.push(...gids);
      console.log(`  ${product.title ?? product.id} — ${gids.length} variants`);

      // A gift card with more than 100 variants is not a shape anyone ships, but
      // silently pricing the 101st is exactly the failure being fixed here.
      if (product.variants?.pageInfo?.hasNextPage) truncated++;
    }

    if (!page?.pageInfo?.hasNextPage) break;
    cursor = page.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }

  if (truncated > 0) {
    throw new Error(
      `${truncated} gift card product(s) have more than 100 variants, so this script did ` +
        `not see all of them. Run a full catalogue re-sync instead — it pages properly.`,
    );
  }

  if (variantGids.length === 0) {
    console.log("\nNo gift cards on this shop. Nothing to do.");
    return;
  }

  const alreadyFlagged = await prisma.variantIndex.count({
    where: { shopId: shop.id, variantGid: { in: variantGids }, isGiftCard: true },
  });

  const present = await prisma.variantIndex.count({
    where: { shopId: shop.id, variantGid: { in: variantGids } },
  });

  console.log(
    `\n${variantGids.length} gift card variants at Shopify, ${present} of them mirrored, ` +
      `${alreadyFlagged} already flagged.`,
  );

  // Reported rather than assumed away: a gift card Shopify knows about and the mirror
  // does not is a sync gap, and it is the kind that hides because the row simply is not
  // there to look wrong.
  if (present < variantGids.length) {
    console.log(
      `  ${variantGids.length - present} are not in the mirror at all — re-sync the ` +
        `catalogue so they exist before relying on this.`,
    );
  }

  if (dryRun) {
    console.log(`\nWould flag ${present - alreadyFlagged} variants. Nothing written.`);
    return;
  }

  const { count } = await prisma.variantIndex.updateMany({
    where: { shopId: shop.id, variantGid: { in: variantGids }, isGiftCard: false },
    data: { isGiftCard: true },
  });

  console.log(`\nFlagged ${count} variants. They are now outside every campaign's scope.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
