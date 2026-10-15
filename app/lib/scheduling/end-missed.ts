/**
 * A scheduled end that could not run (#1005).
 *
 * A scheduled revert that fails is retried every tick, rightly: the sale's prices are still
 * live past its window, and the next attempt may be the one that works. But nobody was told.
 * The release was quiet after the first (#975), no email went out, and the page went on
 * saying the campaign was running as planned, so a sale could outlive its window unnoticed.
 *
 * The first failure is recorded beside the end it missed, the merchant is told once, and
 * the page says so until the revert lands or the end moves.
 */

/** Where the miss is kept, in the campaign's `schedule` JSON beside the window. */
export const END_MISSED_KEY = "endMissed";

interface StoredMiss {
  /** The end that was missed, so a new one (the dates moved) starts clean. */
  endAt: string;
  /** The merchant's sentence for why the revert has not run. */
  reason: string;
  at: string;
}

/** The schedule blob with its current end recorded as missed. */
export function withEndMissed(schedule: unknown, reason: string, at: Date): Record<string, unknown> {
  const blob = { ...((schedule ?? {}) as Record<string, unknown>) };
  const endAt = typeof blob.endAt === "string" ? blob.endAt : "";
  const stored: StoredMiss = { endAt, reason, at: at.toISOString() };
  return { ...blob, [END_MISSED_KEY]: stored };
}

/** Why this campaign's current end has not happened, or null when it has not been missed. */
export function endMissed(schedule: unknown): string | null {
  const blob = (schedule ?? {}) as Record<string, unknown>;
  const stored = blob[END_MISSED_KEY] as Partial<StoredMiss> | undefined;
  if (!stored || typeof stored.reason !== "string" || typeof stored.endAt !== "string") return null;
  if (blob.kind !== "window" || typeof blob.endAt !== "string") return null;
  return Date.parse(stored.endAt) === Date.parse(blob.endAt) ? stored.reason : null;
}
