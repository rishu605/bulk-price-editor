/**
 * Repricing a whole market with one mutation.
 *
 * `priceListUpdate` sets the list's parent adjustment, and every price on the list
 * follows. That replaces hundreds of chunked fixed-price writes with a single call —
 * but it also means the write is all-or-nothing and covers products the campaign may
 * never have looked at, which is why `uniformAdjustment` has to have said yes first.
 *
 * The read-back matters more here than on the fixed path. On the fixed path we send a
 * price and Shopify stores that exact number, so a read-back confirms a value we chose.
 * Here we send a percentage and Shopify computes the prices, rounding its own way from
 * a converted base price we never see. Its answer can differ from ours by a minor unit.
 * The ledger has already promised a specific number, so the difference is not something
 * to shrug at: each row is verified against what Shopify actually derived, and the ones
 * that disagree are corrected with a fixed price rather than quietly marked verified.
 */

import type { AdminClient } from "./sync-executor";

export const PRICE_LIST_PARENT = `#graphql
  query AnchorPriceListParent($id: ID!) {
    priceList(id: $id) {
      id
      currency
      parent {
        adjustment { type value }
        settings { compareAtMode }
      }
      fixed: prices(originType: FIXED, first: 1) {
        nodes { variant { id } }
      }
    }
  }
`;

export const PRICE_LIST_UPDATE = `#graphql
  mutation AnchorPriceListUpdate($id: ID!, $input: PriceListUpdateInput!) {
    priceListUpdate(id: $id, input: $input) {
      priceList {
        id
        parent { adjustment { type value } }
      }
      userErrors { field message code }
    }
  }
`;

export interface ParentState {
  /** The list's own standing adjustment in basis points, or null if it has no parent. */
  adjustmentBps: number | null;
  /** True when at least one variant has a fixed price shadowing the parent. */
  hasFixedOverrides: boolean;
}

interface ParentResponse {
  priceList?: {
    parent?: {
      adjustment?: { type?: string; value?: number } | null;
    } | null;
    fixed?: { nodes?: unknown[] } | null;
  } | null;
}

/**
 * The list's parent adjustment and whether anything overrides it.
 *
 * Read live rather than from the mirror. The mirror is refreshed on a schedule and by
 * webhook, and a merchant who set a price by hand five minutes ago is exactly the
 * merchant whose market must not be repriced wholesale on stale evidence.
 */
export async function readParentState(
  client: AdminClient,
  priceListGid: string,
): Promise<ParentState | null> {
  const response = await client.request<ParentResponse>(PRICE_LIST_PARENT, {
    id: priceListGid,
  });

  const list = response.data?.priceList;
  if (!list) return null;

  const adjustment = list.parent?.adjustment;

  return {
    adjustmentBps: toBps(adjustment),
    hasFixedOverrides: (list.fixed?.nodes ?? []).length > 0,
  };
}

/** Shopify's signed-magnitude adjustment as a single signed integer. */
export function toBps(
  adjustment: { type?: string; value?: number } | null | undefined,
): number | null {
  if (!adjustment || typeof adjustment.value !== "number") return null;

  const magnitude = Math.round(adjustment.value * 100);
  return adjustment.type === "PERCENTAGE_DECREASE" ? -magnitude : magnitude;
}

export interface ParentWriteResult {
  ok: boolean;
  /** What the list's adjustment is now, read back from the mutation's own response. */
  appliedBps: number | null;
  errors: string[];
}

interface UpdateResponse {
  priceListUpdate?: {
    priceList?: { parent?: { adjustment?: { type?: string; value?: number } | null } | null } | null;
    userErrors?: Array<{ field?: string[] | null; message?: string; code?: string | null }>;
  };
}

export async function setParentAdjustment(
  client: AdminClient,
  priceListGid: string,
  adjustment: { type: string; value: number },
): Promise<ParentWriteResult> {
  const response = await client.request<UpdateResponse>(PRICE_LIST_UPDATE, {
    id: priceListGid,
    input: { parent: { adjustment } },
  });

  const payload = response.data?.priceListUpdate;
  const errors = (payload?.userErrors ?? []).map(
    (error) => error.message ?? "Shopify rejected the change without saying why.",
  );

  const appliedBps = toBps(payload?.priceList?.parent?.adjustment);

  // Success is Shopify echoing the adjustment back, not merely the absence of errors.
  // A mutation that returns no price list and no error has told us nothing, and
  // treating silence as success here means reporting a whole market repriced when it
  // may not have been.
  return {
    ok: errors.length === 0 && appliedBps !== null,
    appliedBps,
    errors:
      errors.length === 0 && appliedBps === null
        ? ["Shopify accepted the request but did not report the market's new adjustment."]
        : errors,
  };
}

/** How the run priced a market. Recorded so a revert knows what it is undoing. */
export type MarketWritePath = "market-wide" | "per-product";
