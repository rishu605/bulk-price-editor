import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "react-router";

/**
 * Follows a run the page is not waiting on, and reloads the page once it finishes (#790).
 *
 * A run too long for its request is handed to the background worker, and the action
 * answers at once with the campaign reading Applying. Before this the page then sat on
 * Applying until the merchant thought to reload it -- and a page that never changes reads
 * as a run that is stuck. The same is true of a page opened while a scheduled run or
 * another tab's run is writing.
 *
 * Polls `app.campaign-status`, one indexed read, rather than revalidating the page: the
 * page's loader plans the whole campaign (#812), and doing that every few seconds for as
 * long as a run lasts would be its own outage.
 *
 * Returns how long the run has left, as the latest answer put it (#820): see `etaFrom`.
 */

/** The states a run is writing in. Anything else is where a run ends up. */
export const IN_FLIGHT: ReadonlySet<string> = new Set(["APPLYING", "REVERTING"]);

/** How often to ask. A run in the worker takes minutes; this is not a race. */
export const POLL_MS = 5_000;

/**
 * Whether a polled answer means the page is out of date.
 *
 * Only an answer this page asked for since the run began counts. A fetcher keeps its last
 * answer, so after a re-apply the "Active" it heard at the end of the previous run is
 * still there, and acting on it would reload the page in a loop until the next poll.
 */
export function finished(pageState: string, polled: string | null | undefined, askedThisRun: boolean): boolean {
  return askedThisRun && IN_FLIGHT.has(pageState) && !!polled && !IN_FLIGHT.has(polled);
}

/**
 * The estimate to show beside a run: the latest answer's, kept while the next is asked for so
 * the line does not blink every five seconds. None on a page no longer mid-run: another action
 * can reload it into the finished campaign before a poll has heard the run end, and the
 * fetcher still holds the estimate it gave before.
 */
export function etaFrom(pageState: string, polled: { eta?: string | null } | undefined): string | null {
  return IN_FLIGHT.has(pageState) ? (polled?.eta ?? null) : null;
}

export function useRunPolling(campaignId: string, state: string): string | null {
  const status = useFetcher<{ status: string | null; eta?: string | null }>();
  const revalidator = useRevalidator();
  const inFlight = IN_FLIGHT.has(state);

  // Refs, so the interval is not torn down and restarted by every render the fetcher's own
  // answers cause.
  const load = useRef(status.load);
  useEffect(() => {
    load.current = status.load;
  });
  const asked = useRef(false);

  useEffect(() => {
    asked.current = false;
    if (!inFlight) return;
    // Hidden tabs too: a merchant who switches away while the worker runs should come back
    // to the answer, and the browser already slows a background tab's timers.
    const timer = setInterval(() => {
      asked.current = true;
      void load.current(`/app/campaign-status?id=${encodeURIComponent(campaignId)}`);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, campaignId]);

  const polled = status.state === "idle" ? status.data?.status : undefined;
  useEffect(() => {
    if (!finished(state, polled, asked.current) || revalidator.state !== "idle") return;
    asked.current = false;
    void revalidator.revalidate();
  }, [state, polled, revalidator]);

  return etaFrom(state, status.data);
}
