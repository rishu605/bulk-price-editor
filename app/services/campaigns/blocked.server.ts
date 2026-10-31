/**
 * A blocked plan, in the merchant's words (#1076): each blocking variant by its title. See
 * `lib/planning/blocked-message.ts`.
 */

import type { BreachPolicy } from "../../lib/campaigns/breach-policy";
import { BLOCKED_NAMED, blockedMessage } from "../../lib/planning/blocked-message";
import type { BlockedVariant } from "../../lib/planning/types";
import { titleMapFor } from "./candidates.server";

export async function describeBlocked(
  shopId: string,
  blocked: readonly BlockedVariant[],
  when: "preview" | "run",
  /** The planned campaign's floor-breach policy, which decides what it is told to do (#1161). */
  breach?: BreachPolicy,
): Promise<string> {
  // Titles for the ones named only; the rest are a count.
  const titles = await titleMapFor(shopId, [...new Set(blocked.slice(0, BLOCKED_NAMED).map((entry) => entry.ref.variantGid))]);
  return blockedMessage(
    blocked.map((entry) => ({
      title: nameOf(entry.ref.variantGid, titles.get(entry.ref.variantGid)),
      reason: entry.reason,
      ...(entry.wouldBe ? { wouldBe: entry.wouldBe } : {}),
      ...(entry.floor ? { floor: entry.floor } : {}),
    })),
    when,
    breach,
  );
}

/**
 * The variant's title, or its number when the mirror has no title for it -- never the Admin
 * API's `gid://` form, which is what the mirror falls back to and nobody can look up.
 */
function nameOf(variantGid: string, title: string | undefined): string {
  return title && !title.startsWith("gid://") ? title : `variant ${variantGid.split("/").pop()}`;
}
