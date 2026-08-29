import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";

import type { KeepersAfterRevert } from "../../services/campaigns/keepers.server";

/**
 * Who would keep these variants if this campaign were reverted.
 *
 * A hook, in the route, for two reasons. The tab bodies take their fetcher as a prop —
 * `campaign-header.test.tsx` renders them under a `StaticRouter`, where `useFetcher`
 * throws — so a component that reaches for one of its own stops being testable. And the
 * route is held under 400 lines by `sections.test.ts`, so the asking has somewhere to
 * live that is neither the route body nor a component that cannot be rendered.
 *
 * Asked once, lazily, and never in the loader: answering means planning the whole scope
 * again with this campaign excluded, and most visits to a campaign page never press
 * Revert. Putting it in the loader would be #468 in a new place.
 *
 * Not asked at all when there is nothing to revert, or when drifted rows mean the header
 * sends the merchant to the tab instead — in both cases the modal it feeds never opens.
 */
export interface RollbackSummary {
  campaignId: string;
  straightforward: boolean;
  counts: { total: number };
}

/**
 * Whether the answer is worth asking for.
 *
 * Pure and exported so it can be tested: `useFetcher` throws outside a data router, and
 * the components on this page are rendered under a `StaticRouter`, so the hook itself
 * cannot be. The decision is the part with a wrong answer available — asking always is a
 * plan of the whole scope on every campaign page, for a modal most visits never open.
 */
export function shouldAskForKeepers(rollback: RollbackSummary | null): boolean {
  if (!rollback) return false;
  // Drifted rows send the merchant to the tab, where the modal never opens.
  if (!rollback.straightforward) return false;
  // Nothing to revert means no button, so nothing to explain.
  return rollback.counts.total > 0;
}

export function useKeepers(
  rollback: RollbackSummary | null,
): { keepers: KeepersAfterRevert | null; pending: boolean } {
  const fetcher = useFetcher<KeepersAfterRevert>();
  const asked = useRef(false);

  const wanted = shouldAskForKeepers(rollback);
  const campaignId = rollback?.campaignId;

  useEffect(() => {
    if (asked.current || !wanted || !campaignId) return;
    asked.current = true;
    fetcher.submit({ campaignId }, { method: "post", action: "/app/revert-preview" });
  }, [wanted, campaignId, fetcher]);

  return { keepers: fetcher.data ?? null, pending: wanted && fetcher.state !== "idle" };
}
