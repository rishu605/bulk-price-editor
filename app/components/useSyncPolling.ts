import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "react-router";

import type { SyncState } from "../services/sync-job.server";

/** How often Home asks while a sync runs. Its steps take minutes; this is not a race. */
export const SYNC_POLL_MS = 5_000;

/**
 * Follows a catalogue sync running in the worker (#801): the latest state while it runs,
 * then one reload of the page when it ends.
 *
 * Polls `app.sync-status`, one indexed read, not the Home loader. Only an answer asked for
 * since this sync began counts: a fetcher keeps its last answer, and the "not running" it
 * heard at the end of the previous sync would otherwise reload the page straight away,
 * which reads "running", which acts on the same stale answer again.
 */
export function useSyncPolling(initial: SyncState): SyncState {
  const status = useFetcher<{ sync: SyncState | null }>();
  const revalidator = useRevalidator();
  const load = useRef(status.load);
  useEffect(() => {
    load.current = status.load;
  });
  const asked = useRef(false);

  useEffect(() => {
    asked.current = false;
    if (!initial.running) return;
    const timer = setInterval(() => {
      asked.current = true;
      void load.current("/app/sync-status");
    }, SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [initial.running]);

  const polled = status.state === "idle" ? (status.data?.sync ?? null) : null;

  useEffect(() => {
    if (!asked.current || !initial.running || !polled || polled.running || revalidator.state !== "idle") return;
    asked.current = false;
    void revalidator.revalidate();
  }, [initial.running, polled, revalidator]);

  // The polled state while the sync runs, so the step and its count move; the page's own
  // the rest of the time.
  return initial.running && polled?.running ? polled : initial;
}
