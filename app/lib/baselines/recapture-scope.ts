/**
 * What a recapture covers, and how the recapture page names it.
 *
 * Not in `recapture.server`, because the page's component needs `STALE_SCOPE` to render
 * its scope picker, and a component importing a `.server` module breaks the client build.
 */

export interface RecaptureScope {
  /** A saved segment, or the whole catalogue when absent. */
  segmentId?: string;
  /**
   * Only variants whose price was changed outside the app with no campaign running on
   * them -- the baselines that are out of date (#745). Takes precedence over a segment.
   */
  stale?: boolean;
}

/** What the recapture page's scope picker sends for `stale`. Never a segment id: those are cuids. */
export const STALE_SCOPE = "stale";

/** The scope a page's `segment` value names: a saved segment, the stale set, or everything. */
export function recaptureScopeFrom(value: string | null | undefined): RecaptureScope {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return {};
  return trimmed === STALE_SCOPE ? { stale: true } : { segmentId: trimmed };
}
