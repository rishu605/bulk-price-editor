/**
 * What Home's result banner renders, from whatever the action handed back.
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
  /** Present on the paths that have detail to add. Absent on the ones that do not. */
  errors?: string[];
}

export interface ResultBanner {
  tone: "success" | "critical";
  message: string;
  /** Always an array, so the caller maps without asking. */
  errors: string[];
}

/** The banner for an action's reply, or null when there is nothing to report. */
export function resultBanner(result: ActionOutcome | undefined): ResultBanner | null {
  if (!result) return null;

  return {
    tone: result.ok ? "success" : "critical",
    message: result.message,
    // The whole point: a path that returns no detail returns no detail, rather than
    // taking the page down for not having any.
    errors: result.errors ?? [],
  };
}
