import { useCallback, useEffect, useRef } from "react";
import { useFetcher } from "react-router";

import { SCOPE_FIELD } from "../../lib/segments/scope-builder";
import { MatchCount } from "./MatchCount";

/** What `/app/scope-count` answers: the count and a sample, or why it cannot count. */
export type ScopeCount = { matched: number; sample: string[]; problem?: undefined } | { problem: string; matched?: undefined; sample?: undefined };

/**
 * The Segments form's live count (#817): asked of `/app/scope-count` as the builder changes,
 * debounced as the editor's preview is, and once as the form opens so an edited segment shows
 * what it matches now. The editor counts from its preview instead, which prices the same scope.
 */
export function useScopeCount(initial: string) {
  const fetcher = useFetcher<ScopeCount>();
  const submit = useRef(fetcher.submit);
  useEffect(() => {
    submit.current = fetcher.submit;
  }, [fetcher.submit]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ask = useCallback((encoded: string) => {
    submit.current({ [SCOPE_FIELD]: encoded }, { method: "post", action: "/app/scope-count" });
  }, []);
  const request = useCallback(
    (encoded: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => ask(encoded), 400);
    },
    [ask],
  );

  // Once, as the form opens: a ref rather than an empty list, as the editor's first preview.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    ask(initial);
  }, [ask, initial]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const answer = fetcher.data;
  return {
    request,
    count: (
      <MatchCount
        matched={answer?.matched ?? null}
        pending={fetcher.state !== "idle"}
        problem={answer?.problem}
        sample={answer?.sample}
      />
    ),
  };
}
