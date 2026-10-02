/**
 * The shop's catalogue sync, for a page following one (#801).
 *
 * Home polls this while a sync runs, so it can say which step the sync is on and how far
 * that step has got, and read itself again once when the sync ends. One indexed read: the
 * Home loader counts its way across the whole shop, which is the wrong thing to ask every
 * few seconds for as long as a twelve-minute sync lasts.
 */

import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncStateOf } from "../services/sync-job.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    select: { syncStartedAt: true, syncPhase: true, syncProgress: true, syncHeartbeatAt: true, syncFailure: true },
  });
  return { sync: shop ? syncStateOf(shop) : null };
};
