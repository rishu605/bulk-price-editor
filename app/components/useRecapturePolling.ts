import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator, useSearchParams } from "react-router";

import type { RecaptureState } from "../lib/baselines/recapture-progress";

/** How often the recapture page asks while the worker has its recapture: as Home asks of a sync. */
export const RECAPTURE_POLL_MS = 5_000;

/**
 * Whether a polled answer means the recapture the page is following has ended.
 *
 * Only an answer about this recapture, asked for since it began, counts. A fetcher keeps its
 * last answer, so the "finished" it heard at the end of the previous recapture would reload
 * the page straight away, which reads "running", which acts on the same stale answer again.
 */
export function recaptureEnded(followed: string | null, polled: RecaptureState | null | undefined, asked: boolean): boolean {
  return asked && followed !== null && !!polled && polled.id === followed && !polled.running;
}

/**
 * Follows a recapture running in the worker (#1105): the latest state while it runs, then one
 * reload of the page when it ends, with the recapture in the URL so the reload shows how it
 * ended -- the recaptured sentence, or why it stopped.
 *
 * Polls `app.recapture-status`, one indexed read, not the page: the page's loader plans the
 * whole scope against every running campaign, which is the wrong thing to do every few
 * seconds for as long as a recapture lasts.
 */
export function useRecapturePolling(initial: RecaptureState | null): RecaptureState | null {
  const status = useFetcher<{ recapture: RecaptureState | null }>();
  const revalidator = useRevalidator();
  const [params, setSearchParams] = useSearchParams();
  // Refs, so the interval is not torn down and restarted by every render the answers cause.
  const load = useRef(status.load);
  useEffect(() => {
    load.current = status.load;
  });
  const asked = useRef(false);

  const followed = initial?.running ? initial.id : null;
  useEffect(() => {
    asked.current = false;
    if (!followed) return;
    // Hidden tabs too: a merchant who switches away should come back to the answer, and the
    // browser already slows a background tab's timers.
    const timer = setInterval(() => {
      asked.current = true;
      void load.current(`/app/recapture-status?id=${encodeURIComponent(followed)}`);
    }, RECAPTURE_POLL_MS);
    return () => clearInterval(timer);
  }, [followed]);

  const polled = status.state === "idle" ? (status.data?.recapture ?? null) : null;
  const inUrl = params.get("recapture") === followed;
  useEffect(() => {
    if (!recaptureEnded(followed, polled, asked.current) || revalidator.state !== "idle") return;
    asked.current = false;
    // A recapture this page found running rather than started -- another tab's, or one from
    // before a reload -- goes into the URL now, so the page that reloads says how it ended.
    if (inUrl) void revalidator.revalidate();
    else
      setSearchParams(
        (next) => {
          next.set("recapture", followed!);
          return next;
        },
        { replace: true },
      );
  }, [followed, polled, revalidator, inUrl, setSearchParams]);

  // The polled state while it runs, so the step and its count move; the page's own otherwise.
  return followed && polled?.id === followed && polled.running ? polled : initial;
}
