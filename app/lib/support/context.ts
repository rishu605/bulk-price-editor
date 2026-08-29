/**
 * What gets attached to a support request, and nothing else.
 *
 * The point of attaching anything is that the first reply should not be "which shop, and
 * what were you doing" — a merchant contacting us at 9pm before a sale has already spent
 * their patience on the problem. The point of attaching *only this* is that a support
 * mailbox is not somewhere a merchant's prices should end up: `docs/telemetry` says shop
 * id, plan, counts and durations, never a value.
 *
 * So the context is a fixed record with named fields rather than a bag the caller fills.
 * A `Record<string, unknown>` would pass every review and then, one day, carry a preview
 * row into an inbox — and the shape of that mistake is that nobody would find out.
 * `context.test.ts` checks the fields against this list.
 *
 * ## The merchant's own message is not filtered
 *
 * They typed it and pressed Send, and if the fastest way to explain the problem is "it
 * priced the jacket at 19.99 instead of 29.99" then that sentence *is* the support
 * request. Redacting it would leave us answering a question we had just made unreadable.
 * The rule is about what we attach without being asked.
 */

export interface SupportContext {
  /** Which shop, so support does not have to ask. */
  shopDomain: string;
  /** Which plan, because half of what looks like a bug is an entitlement. */
  plan: string;
  /** Which release, so a fixed bug is recognisable as one. */
  appVersion: string;
  /** Where they were when it went wrong. A path, never a URL with query values. */
  path: string;
  /** The campaign in context, if any. */
  campaignId: string | null;
  /** The run in context — the id the ledger and the activity log are both keyed by. */
  runId: string | null;
  /** The error id from the screen they were looking at, which is the whole point. */
  errorId: string | null;
}

/** The only keys that may ever appear. Adding one is a deliberate act, not a spread. */
export const CONTEXT_FIELDS = [
  "shopDomain",
  "plan",
  "appVersion",
  "path",
  "campaignId",
  "runId",
  "errorId",
] as const satisfies readonly (keyof SupportContext)[];

export function supportContext(input: {
  shopDomain: string;
  plan: string;
  appVersion: string;
  path?: string | null;
  campaignId?: string | null;
  runId?: string | null;
  errorId?: string | null;
}): SupportContext {
  return {
    shopDomain: input.shopDomain,
    plan: input.plan,
    appVersion: input.appVersion,
    // The path only. A query string is where a filter, a search term or an amount ends
    // up, and "where were you" is answered by the route.
    path: pathOnly(input.path),
    campaignId: input.campaignId || null,
    runId: input.runId || null,
    errorId: input.errorId || null,
  };
}

/**
 * The labels a merchant sees before they press Send.
 *
 * Shown, not summarised. "We will attach some diagnostic information" is how a merchant
 * learns not to trust a Send button; a list they can read is how they learn they can.
 */
export const CONTEXT_LABELS: Record<keyof SupportContext, string> = {
  shopDomain: "Shop",
  plan: "Plan",
  appVersion: "App version",
  path: "Page",
  campaignId: "Campaign",
  runId: "Run",
  errorId: "Error id",
};

/** The context as the lines that go in the email, skipping what is not there. */
export function contextLines(context: SupportContext): string[] {
  return CONTEXT_FIELDS.filter((field) => context[field]).map(
    (field) => `${CONTEXT_LABELS[field]}: ${context[field]}`,
  );
}

function pathOnly(value: string | null | undefined): string {
  if (!value) return "";
  const path = value.split("?")[0]!.split("#")[0]!;
  // Absolute URLs happen when a caller passes `window.location.href`. Keep the path.
  return path.startsWith("http") ? new URL(path).pathname : path;
}
