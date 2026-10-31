/**
 * One campaign's state, for a page waiting on a run (#790) or on a plan (#812).
 *
 * A run too long for its request goes to the background worker, and the campaign page
 * reads Applying until it finishes; a plan too large for the page is worked out there too,
 * and the page shows the last numbers it has until a newer plan is stored. The page has to
 * notice when either ends, and its own loader is the wrong thing to ask every few seconds.
 * This is two indexed reads, so the page polls here and reloads itself once, when the
 * answer changes. While a run writes, up to two more say how long it has left
 * (`runEtaOf`, #820).
 *
 * Outside `/app/campaigns/*` for the same reason `app.revert-preview` is:
 * `app.campaigns.$id` would read the segment as a campaign id.
 */

import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { planStatus } from "../services/campaigns/plan-summary.server";
import { runEtaOf } from "../services/campaigns/run-eta.server";
import { IN_FLIGHT } from "../components/campaign/useRunPolling";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = new URL(request.url).searchParams.get("id") ?? "";

  // Scoped to the session's shop in the query itself, so one store can never read the
  // state of another's campaign by guessing an id.
  const campaign = id
    ? await prisma.campaign.findFirst({
        where: { id, shop: { domain: session.shop } },
        select: { status: true, shopId: true },
      })
    : null;

  return {
    status: campaign?.status ?? null,
    // When its newest stored plan was made, and whether one is still on its way (#812).
    plan: campaign ? await planStatus({ domain: session.shop }, id) : { at: null, waiting: false },
    // How long its run has left, once that can be seen (#820). Only a campaign mid-run has one.
    eta: campaign && IN_FLIGHT.has(campaign.status) ? await runEtaOf(campaign.shopId, id) : null,
  };
};
