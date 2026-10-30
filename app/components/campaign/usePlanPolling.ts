import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "react-router";

import { POLL_MS } from "./useRunPolling";

/**
 * Follows a campaign's plan while the worker works it out, and reloads the page once a newer
 * one is stored (#812).
 *
 * A campaign too large to plan while its page loads is planned in the background, and the
 * page shows the last numbers it has -- saying they are being worked out again -- or says one
 * is on its way. A page that then never changed would leave those numbers up for as long as
 * it stayed open. So it polls `app.campaign-status`, two indexed reads, and reloads when the
 * answer says the stored plan is newer than the one shown.
 *
 * Also when nothing is on its way any more: the job found the campaign's own run writing and
 * stood down, or the ask went quiet. The reload asks again, once -- the loader claims the ask,
 * so the next answer says one is on its way and this waits.
 */

export interface PlanPoll {
  /** When the newest stored plan was made, ISO, or null for none. */
  at: string | null;
  /** A plan has been asked of the worker and is still on its way. */
  waiting: boolean;
}

/**
 * Whether a polled answer means the page should reload. Only an answer asked for since the
 * page began waiting counts: a fetcher keeps its last answer, and the one it heard before the
 * last reload would reload the page again in a loop.
 */
export function planArrived(
  page: { asOf?: string; recomputing?: string; planning?: string },
  polled: PlanPoll | null | undefined,
  askedThisWait: boolean,
): boolean {
  if (!askedThisWait || !polled || !(page.recomputing || page.planning)) return false;
  if (polled.at && polled.at !== (page.asOf ?? null)) return true;
  return !polled.waiting;
}

export function usePlanPolling(
  campaignId: string,
  preview: { asOf?: string; recomputing?: string; planning?: string },
): void {
  const status = useFetcher<{ status: string | null; plan: PlanPoll }>();
  const revalidator = useRevalidator();
  const waiting = Boolean(preview.recomputing || preview.planning);

  // Refs, so the interval is not torn down and restarted by every render the answers cause.
  const load = useRef(status.load);
  useEffect(() => {
    load.current = status.load;
  });
  const asked = useRef(false);

  useEffect(() => {
    asked.current = false;
    if (!waiting) return;
    const timer = setInterval(() => {
      asked.current = true;
      void load.current(`/app/campaign-status?id=${encodeURIComponent(campaignId)}`);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, campaignId, preview.asOf]);

  const polled = status.state === "idle" ? status.data?.plan : undefined;
  useEffect(() => {
    if (!planArrived(preview, polled, asked.current) || revalidator.state !== "idle") return;
    asked.current = false;
    void revalidator.revalidate();
  }, [preview, polled, revalidator]);
}
