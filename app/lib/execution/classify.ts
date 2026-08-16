/**
 * Deciding what a failure means, per RFC §11.
 *
 * Four classes, because they have four different remedies and conflating any two of
 * them produces a specific, known failure:
 *
 *   RETRYABLE    Throttles, timeouts, 5xx. Back off and try again; these succeed.
 *   TERMINAL_ROW This one variant will never succeed -- deleted, or rejected for a
 *                reason specific to it. Quarantine it and *keep going*. One poison
 *                row must never hold 149,999 others hostage.
 *   TERMINAL_RUN Nothing will succeed: the token was revoked, the plan gate closed.
 *                Retrying is a rate-limit-consuming way of failing 150,000 times.
 *   USER_FIXABLE The merchant can resolve it -- a price below cost, an invalid
 *                compare-at. Retrying identical input is pointless; say what to fix.
 *
 * The reason is machine-readable as well as human-readable, so the UI can group
 * "these 40 rows failed for the same reason" rather than printing 40 sentences.
 */

export type FailureClass = "RETRYABLE" | "TERMINAL_ROW" | "TERMINAL_RUN" | "USER_FIXABLE";

export type FailureReason =
  | "throttled"
  | "network"
  | "shopify-internal"
  | "variant-deleted"
  | "variant-invalid"
  | "price-rejected"
  | "compare-at-invalid"
  | "auth-revoked"
  | "plan-gate"
  | "below-cost"
  | "unknown";

export interface Classification {
  class: FailureClass;
  reason: FailureReason;
  /** Shown per row in the ledger. Names the object, the cause and the next action. */
  message: string;
}

export function isRetryable(classification: Classification): boolean {
  return classification.class === "RETRYABLE";
}

/**
 * Classifies whatever Shopify or the transport gave us.
 *
 * Takes the message text because that is genuinely all Shopify offers for
 * `userErrors` -- there is no stable code on them. Doing the matching in one tested
 * place keeps the guesswork auditable instead of scattering it through the executor.
 */
export function classifyFailure(error: unknown): Classification {
  const text = messageOf(error).toLowerCase();

  // A variant deleted while the run was in flight is not a failure -- the merchant
  // deleted it, and reporting it as an error trains people to ignore errors (E4).
  if (
    text.includes("does not exist") ||
    text.includes("was not found") ||
    text.includes("not found") ||
    text.includes("has been deleted")
  ) {
    return {
      class: "TERMINAL_ROW",
      reason: "variant-deleted",
      message:
        "This variant no longer exists in Shopify — it was deleted while the run was in progress. Nothing was written for it.",
    };
  }

  if (text.includes("throttled") || (text.includes("rate") && text.includes("limit"))) {
    return {
      class: "RETRYABLE",
      reason: "throttled",
      message: "Shopify rate-limited this write. It will be retried automatically.",
    };
  }

  if (
    text.includes("fetch failed") ||
    text.includes("econnreset") ||
    text.includes("econnrefused") ||
    text.includes("etimedout") ||
    text.includes("socket hang up") ||
    text.includes("timeout")
  ) {
    return {
      class: "RETRYABLE",
      reason: "network",
      message: "The connection to Shopify failed. It will be retried automatically.",
    };
  }

  if (
    text.includes("internal error") ||
    text.includes("service unavailable") ||
    text.includes("502") ||
    text.includes("503")
  ) {
    return {
      class: "RETRYABLE",
      reason: "shopify-internal",
      message: "Shopify returned an internal error. It will be retried automatically.",
    };
  }

  // Auth and plan gates fail every remaining row identically, so stopping the run is
  // the kind thing to do -- it leaves the ledger honest instead of 150,000 identical
  // failures.
  if (
    text.includes("access denied") ||
    text.includes("unauthorized") ||
    text.includes("invalid api key") ||
    text.includes("access token")
  ) {
    return {
      class: "TERMINAL_RUN",
      reason: "auth-revoked",
      message:
        "The app's access to this store was revoked or expired. Reinstall the app, then resume this run — rows already written are untouched.",
    };
  }

  if (text.includes("not available on your plan") || text.includes("plan does not")) {
    return {
      class: "TERMINAL_RUN",
      reason: "plan-gate",
      message:
        "This store's Shopify plan does not allow this operation. The run stopped; nothing further was written.",
    };
  }

  if (text.includes("compare at") || text.includes("compare_at")) {
    return {
      class: "USER_FIXABLE",
      reason: "compare-at-invalid",
      message:
        "Shopify rejected the compare-at price for this variant — it must be above the selling price. Adjust the campaign's compare-at rule and run it again.",
    };
  }

  if (text.includes("below cost") || text.includes("cost")) {
    return {
      class: "USER_FIXABLE",
      reason: "below-cost",
      message:
        "This price would fall below the variant's cost. Change the guardrail in Settings or exclude the variant, then run it again.",
    };
  }

  if (
    text.includes("price") &&
    (text.includes("invalid") || text.includes("must be") || text.includes("greater"))
  ) {
    return {
      class: "USER_FIXABLE",
      reason: "price-rejected",
      message:
        "Shopify rejected the price for this variant as invalid. Check the campaign's rule and rounding, then run it again.",
    };
  }

  if (text.includes("invalid") || text.includes("cannot be")) {
    return {
      class: "TERMINAL_ROW",
      reason: "variant-invalid",
      message:
        "Shopify rejected this variant for a reason specific to it. The rest of the run continued; see the message in the ledger.",
    };
  }

  // Unknown failures are retried rather than quarantined. Retrying something terminal
  // wastes a few attempts; quarantining something transient silently drops a price
  // change the merchant asked for, which is far worse.
  return {
    class: "RETRYABLE",
    reason: "unknown",
    message: "This write failed for an unrecognised reason and will be retried.",
  };
}

/** True when the whole run should stop rather than work through every remaining row. */
export function stopsTheRun(classification: Classification): boolean {
  return classification.class === "TERMINAL_RUN";
}

/**
 * Whether a row that has failed this many times should be quarantined.
 *
 * Only RETRYABLE rows get attempts at all -- there is no point spending five on a
 * variant that has been deleted.
 */
export function shouldQuarantine(
  classification: Classification,
  attempt: number,
  maxAttempts = MAX_ATTEMPTS,
): boolean {
  if (classification.class === "TERMINAL_RUN") return false;
  if (classification.class !== "RETRYABLE") return true;
  return attempt >= maxAttempts;
}

export const MAX_ATTEMPTS = 5;

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
}
