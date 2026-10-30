/**
 * One error type, so every failure reaches the merchant as a sentence they can act
 * on and reaches us with enough detail to debug.
 *
 * Raw errors are useless at both ends. `PrismaClientKnownRequestError: P2025` tells a
 * merchant nothing, and "Something went wrong" tells us nothing. An AppError carries
 * both: a `userMessage` written for the person looking at the screen, and a `code`
 * plus `context` written for whoever reads the logs afterwards.
 *
 * `retryable` is the third audience: the worker. A throttle is worth retrying, a
 * guardrail block never is, and code that has to guess by matching on message strings
 * gets it wrong eventually.
 */

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "NO_SESSION"
  | "SHOPIFY_THROTTLED"
  | "SHOPIFY_UNAVAILABLE"
  | "SHOPIFY_REJECTED"
  | "GUARDRAIL_BLOCKED"
  | "MARKET_MISCONFIGURED"
  | "NOT_FOUND"
  | "VALIDATION"
  | "DB_UNAVAILABLE"
  | "UNKNOWN";

export interface AppErrorOptions {
  code: ErrorCode;
  /** Written for the merchant: what happened, and what to do about it. */
  userMessage: string;
  /** Structured detail for the log. Must never contain tokens or secrets. */
  context?: Record<string, unknown>;
  cause?: unknown;
  retryable?: boolean;
  status?: number;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "SHOPIFY_THROTTLED",
  "SHOPIFY_UNAVAILABLE",
  "DB_UNAVAILABLE",
]);

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  NO_SESSION: 401,
  SHOPIFY_THROTTLED: 429,
  SHOPIFY_UNAVAILABLE: 502,
  SHOPIFY_REJECTED: 422,
  GUARDRAIL_BLOCKED: 422,
  MARKET_MISCONFIGURED: 422,
  NOT_FOUND: 404,
  VALIDATION: 400,
  DB_UNAVAILABLE: 503,
  UNKNOWN: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly context: Record<string, unknown>;
  readonly retryable: boolean;
  readonly status: number;

  constructor(options: AppErrorOptions) {
    // The technical message stays on `message` for logs; `userMessage` is what the
    // screen shows. Conflating them is how stack traces end up in front of merchants.
    super(options.userMessage, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.context = options.context ?? {};
    this.retryable = options.retryable ?? RETRYABLE.has(options.code);
    this.status = options.status ?? STATUS[options.code];
  }
}

/**
 * True for one of the codes above, and nothing else.
 *
 * For a code that arrives from outside the process: a browser crash report names its own
 * (#783), and the endpoint stores only a code this list has, so a row's code is always one
 * the alerts and Diagnostics know how to read.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STATUS, value);
}

/** The sentence a code shows when nothing more specific was written for it. */
export function userMessageFor(code: ErrorCode): string {
  return USER_MESSAGE[code];
}

/**
 * Normalises anything thrown into an AppError.
 *
 * Matching on message text is unpleasant, but the alternative is worse: these errors
 * come from Prisma, `fetch`, and Shopify's GraphQL layer, none of which share a type.
 * Doing it in exactly one place means the guesswork is testable and the rest of the
 * app can rely on the result.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const message = messageOf(error);

  // Before `classify`, whose `P20` catch-all would call a raw query's P2010 a form error.
  // DB_UNAVAILABLE -- a 503, retryable -- because it is the database being busy, with its
  // own sentence because "not responding" is not what a page cut off at five seconds saw.
  if (isStatementTimeout(error, message)) {
    return new AppError({
      code: "DB_UNAVAILABLE",
      userMessage: STATEMENT_TIMEOUT_MESSAGE,
      cause: error,
      context: { originalMessage: message.slice(0, 500), timeout: "statement" },
    });
  }

  const code = classify(error, message);

  return new AppError({
    code,
    userMessage: USER_MESSAGE[code],
    cause: error,
    context: { originalMessage: message.slice(0, 500) },
  });
}

const USER_MESSAGE: Record<ErrorCode, string> = {
  UNAUTHENTICATED:
    "Your session expired. Reload the page to sign back in to Shopify.",
  NO_SESSION:
    "This store is no longer connected to the app. Reinstall it from the Shopify admin to continue.",
  SHOPIFY_THROTTLED:
    "Shopify is rate-limiting this store right now. The work is queued and will continue on its own — no prices were left half-written.",
  SHOPIFY_UNAVAILABLE:
    "Could not reach Shopify. This is usually brief; try again in a minute. Any run that had started is safe to resume.",
  SHOPIFY_REJECTED:
    "Shopify rejected part of this change. The ledger below shows exactly which variants were affected and why.",
  GUARDRAIL_BLOCKED:
    "A guardrail stopped this run before anything was written. Lower the floor in Settings, or exclude the variant, then try again.",
  // Every throw of this carries its own message naming the market, the currency it
  // answered in and where to change it -- see `unconvertedMessage`. This generic form is
  // the fallback the `Record` demands, and reaching it means something threw the code
  // without that sentence, which is itself worth noticing.
  MARKET_MISCONFIGURED:
    "A market is returning its prices in the wrong currency, so this campaign will not price that market. Check the market's currency in Shopify under Settings → Markets. Every other surface was priced.",
  NOT_FOUND: "That campaign or record no longer exists. It may have been deleted.",
  VALIDATION: "Some of the values on this form need fixing before it can be saved.",
  DB_UNAVAILABLE:
    "The app's own database is not responding — it may be briefly down or under heavy load. Nothing was changed in your store. Try again shortly.",
  UNKNOWN:
    "Something went wrong on our side. Nothing was changed in your store unless a run reported otherwise.",
};

/**
 * P20xx codes that describe the database being busy rather than the data being wrong.
 *
 * A named set rather than another `startsWith`, because that is what put them in the
 * wrong bucket: `P20` is Prisma's prefix for "query engine", not for "your input was
 * invalid", and treating the prefix as the latter misfiles anything transient it emits.
 *
 * Exported for the run's chunk retry (`lib/db/run-writes.server.ts`, #810), so "what a run waits
 * out" and "what a merchant is told is load" are one list rather than two that drift.
 */
export const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set(["P2024", "P2034"]);

/**
 * Postgres's SQLSTATE for a statement it cancelled: `statement_timeout`, which the web
 * process can now set (#810), or an operator's `pg_cancel_backend`.
 */
const QUERY_CANCELED = "57014";

/**
 * A statement Postgres cancelled for taking too long (#810).
 *
 * Prisma reports it two ways, and both were misfiled. A raw query fails with P2010 and the
 * SQLSTATE in `meta.code` -- and P2010 starts with `P20`, so it read "some of the values on
 * this form need fixing". A model query fails with no code at all, the SQLSTATE only in the
 * engine's message, and read as UNKNOWN. Both shapes were taken from a real cancellation
 * against Postgres 16 under Prisma 6.19, not from the docs.
 */
function isStatementTimeout(error: unknown, message: string): boolean {
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  if (meta?.code === QUERY_CANCELED) return true;
  return message.includes(`"${QUERY_CANCELED}"`) || /canceling statement due to statement timeout/i.test(message);
}

/**
 * What a page that hit its statement timeout says (#810): the object (this page), the cause
 * (the app's database is busy, usually with a large run) and the next action (reload; a run
 * carries on). A run that hits it after writing is told "stopped part-way" instead, by
 * `stoppedPartWay` in the run path, which replaces this sentence.
 */
const STATEMENT_TIMEOUT_MESSAGE =
  "This page took too long to read from the app's database, which is busy right now — usually with a " +
  "large price run on this store or another. Nothing was changed in your store. Reload the page in a " +
  "minute; any run in progress carries on without it.";

function classify(error: unknown, message: string): ErrorCode {
  const prismaCode = (error as { code?: unknown })?.code;

  if (typeof prismaCode === "string") {
    // Prisma's own codes are far more reliable than its messages.
    if (prismaCode === "P2025") return "NOT_FOUND";

    // Two P20xx codes that are not about the data at all, checked before the catch-all
    // below claims them. Both are the database saying "not now", both clear on their
    // own, and both were being reported as VALIDATION -- a 400, marked *not retryable*,
    // telling a merchant that "some of the values on this form need fixing" when the
    // real cause was load. The worker reads `retryable` to decide whether to try again,
    // so the misclassification also turned a transient blip into a failed run.
    //
    //   P2024  timed out waiting for a connection from the pool
    //   P2034  transaction rolled back by a write conflict or deadlock
    if (TRANSIENT_PRISMA_CODES.has(prismaCode)) return "DB_UNAVAILABLE";

    if (prismaCode === "P2002" || prismaCode.startsWith("P20")) return "VALIDATION";
    if (prismaCode.startsWith("P1")) return "DB_UNAVAILABLE";
    if (prismaCode === "ECONNREFUSED" || prismaCode === "ENOTFOUND") {
      return "SHOPIFY_UNAVAILABLE";
    }
  }

  // Prisma refusing the arguments it was handed: a value that is not in an enum, a field
  // the model does not have. It carries no `code`, so it used to fall through to the text
  // below, where Prisma's own "Invalid value for argument `status`" matched the Shopify
  // branch -- and a campaigns link with `status=active` told the merchant that *Shopify*
  // had rejected part of a change, pointing at a ledger that did not exist for a change
  // nobody made (#747).
  //
  // It is our mistake every time: the app built a query the schema does not accept, and
  // nothing reached the store. So it is UNKNOWN, "something went wrong on our side",
  // which is the true sentence. Not VALIDATION -- that tells the merchant to fix a form,
  // and there is no form they could change to make the app send a valid query.
  //
  // By class, through its name rather than `instanceof`. This module is bundled into the
  // browser for the error boundary, and importing the Prisma runtime to recognise one
  // class would ship it there; the name is set by the class itself, so it is the class.
  if (error instanceof Error && error.name === "PrismaClientValidationError") return "UNKNOWN";

  const text = message.toLowerCase();

  if (text.includes("throttled") || (text.includes("exceeded") && text.includes("rate"))) {
    return "SHOPIFY_THROTTLED";
  }
  if (
    text.includes("fetch failed") ||
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("socket hang up") ||
    text.includes("etimedout")
  ) {
    return "SHOPIFY_UNAVAILABLE";
  }
  if (text.includes("blocked by a guardrail")) return "GUARDRAIL_BLOCKED";
  if (text.includes("no usable session")) return "NO_SESSION";
  if (text.includes("access denied") || text.includes("unauthorized")) {
    return "UNAUTHENTICATED";
  }
  // Shopify's own wording only. "provided invalid value" is how its GraphQL layer refuses
  // a variable ("Variable $input of type … was provided invalid value for …"). The bare
  // phrase "invalid value" also matched Prisma, and would match any other library that
  // refuses an argument in the same two words, filing each as Shopify rejecting a price
  // change (#747). The class check above is the fix for Prisma; this is what stops the
  // next library from doing the same.
  if (text.includes("usererrors") || text.includes("provided invalid value")) {
    return "SHOPIFY_REJECTED";
  }

  return "UNKNOWN";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybe = (error as { message?: unknown }).message;
    if (typeof maybe === "string") return maybe;
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      return "Unserialisable error";
    }
  }
  return String(error);
}
