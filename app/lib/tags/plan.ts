/**
 * Deciding which tags a campaign may add, and — far more importantly — which it is
 * allowed to take away again.
 *
 * The tag kit is the deliberate alternative to shipping theme code: a theme keys its
 * sale badge off a tag, and the app never touches the storefront. That only works if
 * the app is scrupulous about ownership.
 *
 * The danger is not adding a tag, it is removing one. If a merchant already had "SALE"
 * on a product for their own reasons and a campaign also asks for "SALE", then
 * `tagsAdd` is a no-op — and a revert that removed it would delete something the app
 * never added. The merchant loses their own merchandising, with no record of why.
 *
 * So the unit of truth is the *delta*: the tags that were genuinely absent before this
 * campaign touched the product. Those are ledgered, and those are the only ones a
 * revert removes. Tags the product already had are recorded too, explicitly, so the
 * ledger can show that the app knew about them and deliberately left them alone.
 */

export interface TagPlan {
  productGid: string;
  /** Absent before, so ours to add — and ours to remove later. */
  toAdd: string[];
  /** Asked for but already present. Never removed, recorded so the choice is visible. */
  alreadyPresent: string[];
}

/** Normalises for comparison. Shopify tags are case-insensitive and space-trimmed. */
export function normaliseTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Splits a campaign's tag kit against what a product already carries.
 *
 * Comparison is case-insensitive because Shopify treats "Sale" and "sale" as the same
 * tag. Adding "Sale" to a product tagged "sale" changes nothing, and a case-sensitive
 * comparison would record it as ours and remove the merchant's tag on revert.
 */
export function planTagsFor(
  productGid: string,
  tagKit: readonly string[],
  currentTags: readonly string[],
): TagPlan {
  const current = new Set(currentTags.map(normaliseTag));
  const toAdd: string[] = [];
  const alreadyPresent: string[] = [];
  const seen = new Set<string>();

  for (const raw of tagKit) {
    const tag = raw.trim();
    if (!tag) continue;

    const key = normaliseTag(tag);
    // A kit listing the same tag twice must not add it twice, or the ledger would
    // claim ownership of one copy of something that only exists once.
    if (seen.has(key)) continue;
    seen.add(key);

    if (current.has(key)) alreadyPresent.push(tag);
    else toAdd.push(tag);
  }

  return { productGid, toAdd, alreadyPresent };
}

/**
 * What a revert should remove, given what the apply runs recorded.
 *
 * Union across every run of the campaign: a recurring sale, or one resumed after a
 * failure, adds tags over several runs and all of them are the campaign's. Taking only
 * the newest run's row would strand tags from earlier ones on the storefront forever —
 * which is the "SALE badge on a full-price product weeks later" this ticket exists to
 * prevent.
 *
 * Tags another still-active campaign also applied are excluded. Two overlapping sales
 * both tagging "SALE" is ordinary, and ending one must not strip the badge from the
 * other.
 */
export function planTagRemoval(
  ledgered: ReadonlyArray<{ productGid: string; addedTags: string[] }>,
  /** Tags still owed by other campaigns, per product. */
  stillOwed: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Array<{ productGid: string; toRemove: string[] }> {
  const byProduct = new Map<string, Set<string>>();

  for (const row of ledgered) {
    const existing = byProduct.get(row.productGid) ?? new Set<string>();
    for (const tag of row.addedTags) existing.add(tag);
    byProduct.set(row.productGid, existing);
  }

  const out: Array<{ productGid: string; toRemove: string[] }> = [];

  for (const [productGid, tags] of byProduct) {
    const owed = stillOwed.get(productGid);
    const toRemove = [...tags].filter((tag) => !owed?.has(normaliseTag(tag)));
    if (toRemove.length > 0) out.push({ productGid, toRemove });
  }

  return out;
}
