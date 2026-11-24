/**
 * What the product picker hands back, as the variants a scope adds or leaves out (#817, PRD
 * A-2.3).
 *
 * App Bridge's `resourcePicker` returns products, each with the variants the merchant ticked:
 * all of them for a product picked whole. A scope is a list of variants, so a product picked
 * whole is every variant it had then. One added later is not in the list, as a pinned list's
 * never is; a merchant who means "this product, whatever variants it grows" means a condition.
 *
 * Plain data, so the component and its tests read the same answer.
 */

import { variantDisplayTitle } from "../catalog/variant-title";
import { MAX_PICKED } from "./scope-builder";

/** A picked variant, with the name the chip shows. */
export interface PickedVariant {
  gid: string;
  title: string;
}

/** The part of the picker's payload this reads. */
export interface PickedProduct {
  title?: string;
  variants?: Array<{ id?: string; title?: string | null }>;
}

/** The picker's products as variants, in the order picked, each once. */
export function variantsPicked(products: readonly PickedProduct[]): PickedVariant[] {
  const seen = new Set<string>();
  const out: PickedVariant[] = [];
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      if (!variant.id || seen.has(variant.id)) continue;
      seen.add(variant.id);
      out.push({ gid: variant.id, title: variantDisplayTitle(product.title, variant.title) ?? variant.id });
    }
  }
  return out;
}

/**
 * A list with these added, up to `MAX_PICKED`, and how many did not fit. Already picked is not
 * picked twice, and the list keeps the order things were picked in.
 */
export function addPicked(current: readonly string[], picked: readonly PickedVariant[]): { list: string[]; leftOver: number } {
  const list = [...current];
  let leftOver = 0;
  for (const { gid } of picked) {
    if (list.includes(gid)) continue;
    if (list.length >= MAX_PICKED) leftOver += 1;
    else list.push(gid);
  }
  return { list, leftOver };
}
