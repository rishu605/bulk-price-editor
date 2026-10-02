/**
 * One campaign's state, for a page waiting on a run (#790).
 *
 * A run too long for its request goes to the background worker, and the campaign page
 * reads Applying until it finishes. The page has to notice when it does, and its own
 * loader is the wrong thing to ask every few seconds: it plans the whole campaign on
 * every load (#812). This is one indexed read, so the page polls here and reloads itself
 * once, when the answer changes.
 *
 * Outside `/app/campaigns/*` for the same reason `app.revert-preview` is:
 * `app.campaigns.$id` would read the segment as a campaign id.
 */

import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = new URL(request.url).searchParams.get("id") ?? "";

  // Scoped to the session's shop in the query itself, so one store can never read the
  // state of another's campaign by guessing an id.
  const campaign = id
    ? await prisma.campaign.findFirst({
        where: { id, shop: { domain: session.shop } },
        select: { status: true },
      })
    : null;

  return { status: campaign?.status ?? null };
};
