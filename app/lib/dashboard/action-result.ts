/**
 * What a result banner renders, from whatever the action handed back. Home and the
 * campaign page both go through it.
 *
 * ## The bug this exists to stop
 *
 * The banner did this:
 *
 * ```tsx
 * <s-paragraph>{result.message}</s-paragraph>
 * {result.errors.map((error) => …)}
 * ```
 *
 * and two of the action's four paths return no `errors` at all — resolving a market
 * notice, and an invalid percentage in "Put everything on sale". Both are things a
 * merchant does on purpose, and both threw `TypeError` during render, so the page they
 * got back was the error boundary. The notice had already been resolved server-side by
 * then, so reloading no longer explained what had happened.
 *
 * Nothing caught it because the route asserted the shape by hand —
 * `type ActionData = { ok; message; errors: string[] }` fed to `useFetcher<ActionData>` —
 * which told the compiler the field was always there. The annotation was the bug.
 *
 * ## Why a function and not a wider type
 *
 * Making `errors` optional would fix the crash and leave every future call site to
 * remember the `?? []`. One decision, in one place, is the same argument `usageLine` and
 * `homeSections` make: the route renders what this returns and has nothing left to get
 * wrong.
 */

/** Anything the action might hand back that is worth putting in a banner. */
export interface ActionOutcome {
  ok: boolean;
  message: string;
  /** A failure that is not an error: deferred to the worker, or waiting on somebody. */
  tone?: "warning";
  /** Home's name for the lines under the message. Absent on the paths with nothing to add. */
  errors?: string[];
  /**
   * The campaign page's name for the same thing. Absent on saving a note, asking for
   * approval and deciding it -- which took the campaign page down the way `errors` took
   * Home down (#714).
   */
  details?: string[];
}

export interface ResultBanner {
  tone: "success" | "critical" | "warning";
  message: string;
  /** Always an array, so the caller maps without asking. */
  lines: string[];
}

/** The banner for an action's reply, or null when there is nothing to report. */
export function resultBanner(result: ActionOutcome | undefined): ResultBanner | null {
  if (!result) return null;

  return {
    tone: result.ok ? "success" : (result.tone ?? "critical"),
    message: result.message,
    // The whole point: a path that returns no detail returns no detail, rather than
    // taking the page down for not having any.
    lines: result.errors ?? result.details ?? [],
  };
}
