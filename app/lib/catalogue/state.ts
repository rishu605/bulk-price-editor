/**
 * Whether Anchor has a catalogue to price yet (#800).
 *
 * The editor had one empty state for "your conditions exclude everything" and "there is no
 * catalogue yet". On a store that had never synced it told the merchant to loosen
 * conditions they had not set, kept the guided button disabled without saying why, and let
 * the full editor create a campaign that could price nothing. The two cases need different
 * sentences, and only one of them is the merchant's filter.
 */

export type CatalogueState = "ready" | "syncing" | "unsynced" | "empty";

/**
 * From the mirror and the shop's sync record. Any variant at all is "ready": a first sync
 * part-way through still has products to preview, and saying otherwise would hide them.
 */
export function catalogueStateFrom(input: { variants: number; synced: boolean; syncing: boolean }): CatalogueState {
  if (input.variants > 0) return "ready";
  if (input.syncing) return "syncing";
  return input.synced ? "empty" : "unsynced";
}

/** What to say instead of "nothing matches", with where to go. Null when there is a catalogue. */
export function catalogueNotice(
  state: CatalogueState,
): { title: string; description: string; action: { label: string; href: string } } | null {
  switch (state) {
    case "unsynced":
      return {
        title: "Anchor hasn't read your catalogue yet",
        description:
          "Campaigns price the products Anchor has read from your store, and it hasn't read any yet. Sync your catalogue from Home: a small store takes a minute or two, a very large one a few minutes. Then come back.",
        action: { label: "Go to Home", href: "/app" },
      };
    case "syncing":
      return {
        title: "Anchor is reading your catalogue",
        description:
          "The first sync is still running, so there are no products to preview yet. Home shows how far it has got; come back when it has finished.",
        action: { label: "See the sync on Home", href: "/app" },
      };
    case "empty":
      return {
        title: "Your store has no products yet",
        description: "Anchor has read your catalogue and found nothing to price. Add products in Shopify, and they appear here within a minute.",
        action: { label: "Go to Home", href: "/app" },
      };
    default:
      return null;
  }
}
