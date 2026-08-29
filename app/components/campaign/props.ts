import type { useFetcher } from "react-router";

import type { action, loader } from "../../routes/app.campaigns.$id";
import type { KeepersAfterRevert } from "../../services/campaigns/keepers.server";

/**
 * Everything the campaign page's tab bodies read.
 *
 * One props type rather than five, deliberately. The bodies were carved out of a single
 * 690-line component that shared one scope, and giving each its own narrow interface
 * would mean five interfaces to update every time the loader gains a field — with the
 * compiler only complaining about the one you happened to change. The tabs are not
 * reusable components; they are the same page, split up so it can be read.
 */
export type CampaignDetailProps = Awaited<ReturnType<typeof loader>> & {
  fetcher: ReturnType<typeof useFetcher<Awaited<ReturnType<typeof action>>>>;
  /** A request is in flight, so every submit button shows it. */
  busy: boolean;
  /** Whether this campaign may be applied at all — lifecycle and guardrails, not row count. */
  canApply: boolean;
  /** The loader renames this; the components keep the clearer name. */
  attention: boolean;
  /**
   * Who would keep these variants if this campaign were reverted, once asked for.
   *
   * Null until the answer arrives, and asked for by the route rather than by the header —
   * see `useKeepers`, and the note there about why a component may not reach for a
   * fetcher of its own.
   */
  keepers: KeepersAfterRevert | null;
  keepersPending: boolean;
};
