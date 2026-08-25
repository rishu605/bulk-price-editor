/**
 * Every merchant-visible error points at a page that explains it.
 *
 * This is the acceptance criterion that makes a help centre real rather than a wiki
 * nobody reads. A merchant who hits "a guardrail stopped this run" at 9pm before a sale
 * does not want a search box — they want the sentence that tells them which guardrail and
 * what to do, one click from where they are.
 *
 * The mapping lives beside the error codes rather than in the docs, so adding a code
 * without a doc is a type error rather than a broken link somebody finds later.
 */

import type { ErrorCode } from "./app-error";

/** Where the published help lives. Overridable so staging can point at itself. */
export const HELP_BASE = process.env.HELP_BASE_URL ?? "https://help.anchorpricing.app";

/**
 * The doc for each error.
 *
 * `Record` rather than a partial map on purpose: a new error code will not compile until
 * somebody has decided what a merchant reading it should be sent to.
 */
const HELP_PATHS: Record<ErrorCode, string> = {
  UNAUTHENTICATED: "/failures/session-expired",
  NO_SESSION: "/failures/store-disconnected",
  SHOPIFY_THROTTLED: "/concepts/rate-limits",
  SHOPIFY_UNAVAILABLE: "/failures/shopify-unreachable",
  SHOPIFY_REJECTED: "/failures/partial-runs",
  GUARDRAIL_BLOCKED: "/failures/guardrail-blocks",
  NOT_FOUND: "/failures/missing-record",
  VALIDATION: "/failures/form-validation",
  DB_UNAVAILABLE: "/failures/app-unavailable",
  UNKNOWN: "/failures/unexpected",
};

/**
 * Takes a plain string, not an `ErrorCode`.
 *
 * The boundary receives the code as a string across the serialisation boundary, and an
 * unrecognised one must not produce `https://help…/undefined` — a broken link under an
 * error message is worse than no link, because it confirms the merchant's suspicion that
 * nobody is looking after this.
 */
export function helpUrlFor(code: string): string {
  return `${HELP_BASE}${HELP_PATHS[code as ErrorCode] ?? HELP_PATHS.UNKNOWN}`;
}

/** What the link should say. Never "click here", and never the URL. */
export function helpLabelFor(code: string): string {
  const labels: Record<ErrorCode, string> = {
    UNAUTHENTICATED: "Why sessions expire",
    NO_SESSION: "Reconnecting your store",
    SHOPIFY_THROTTLED: "How rate limits affect a run",
    SHOPIFY_UNAVAILABLE: "When Shopify is unreachable",
    SHOPIFY_REJECTED: "Understanding a partial run",
    GUARDRAIL_BLOCKED: "How guardrails work",
    NOT_FOUND: "Missing campaigns and records",
    VALIDATION: "Fixing a form",
    DB_UNAVAILABLE: "When the app is unavailable",
    UNKNOWN: "What to do about an unexpected error",
  };

  return labels[code as ErrorCode] ?? labels.UNKNOWN;
}
