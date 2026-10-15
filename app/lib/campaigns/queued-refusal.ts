/**
 * A run handed to the background worker and refused before it wrote anything (#1046).
 *
 * An apply too long for the page, or a Flow start of a few thousand variants, is claimed,
 * queued and answered at once: "the background worker is applying it". The worker's run can
 * still be refused before it writes. A blocking guardrail is found only by planning the whole
 * campaign, which is the work that was too long to do while the request waited; and the
 * campaign can change while the job waits -- its segment deleted, made practice, its approval
 * withdrawn. That refusal reached only the campaign's history: the merchant had been told the
 * apply was under way, Flow's run log said "queued", and nothing said otherwise.
 *
 * So it is kept on the campaign until a later run claims it. The Status card and the list say
 * the run did not happen and why, and the merchant is told once, by email.
 */

/** Where it is kept, in the campaign's `schedule` JSON: the campaign's own record (`OWN_KEYS`). */
export const QUEUED_REFUSED_KEY = "queuedRefused";

export type QueuedVerb = "apply" | "revert" | "resume";

export interface QueuedRefusal {
  verb: QueuedVerb;
  /** The merchant's sentence, through the error taxonomy: what stopped it and what to do. */
  reason: string;
}

/** What a run was asked to do, as the merchant pressed it. */
export function queuedVerb(options: { revert?: boolean; resume?: boolean }): QueuedVerb {
  return options.revert ? "revert" : options.resume ? "resume" : "apply";
}

/** The schedule blob with this refusal recorded, replacing any earlier one. */
export function withQueuedRefused(schedule: unknown, refusal: QueuedRefusal, at: Date): Record<string, unknown> {
  return { ...((schedule ?? {}) as Record<string, unknown>), [QUEUED_REFUSED_KEY]: { ...refusal, at: at.toISOString() } };
}

/** The schedule blob without a recorded refusal, or null when there is none to clear. */
export function withoutQueuedRefused(schedule: unknown): Record<string, unknown> | null {
  const blob = (schedule ?? {}) as Record<string, unknown>;
  if (!(QUEUED_REFUSED_KEY in blob)) return null;
  const rest = { ...blob };
  delete rest[QUEUED_REFUSED_KEY];
  return rest;
}

/** The refusal still standing on this campaign, or null. */
export function queuedRefusal(schedule: unknown): QueuedRefusal | null {
  const stored = ((schedule ?? {}) as Record<string, unknown>)[QUEUED_REFUSED_KEY] as Partial<QueuedRefusal> | undefined;
  if (!stored || typeof stored.reason !== "string") return null;
  if (stored.verb !== "apply" && stored.verb !== "revert" && stored.verb !== "resume") return null;
  return { verb: stored.verb, reason: stored.reason };
}
