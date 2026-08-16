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
  NOT_FOUND: "That campaign or record no longer exists. It may have been deleted.",
  VALIDATION: "Some of the values on this form need fixing before it can be saved.",
  DB_UNAVAILABLE:
    "The app's own database is not responding. Nothing was changed in your store. Try again shortly.",
  UNKNOWN:
    "Something went wrong on our side. Nothing was changed in your store unless a run reported otherwise.",
};

function classify(error: unknown, message: string): ErrorCode {
  const prismaCode = (error as { code?: unknown })?.code;

  if (typeof prismaCode === "string") {
    // Prisma's own codes are far more reliable than its messages.
    if (prismaCode === "P2025") return "NOT_FOUND";
    if (prismaCode === "P2002" || prismaCode.startsWith("P20")) return "VALIDATION";
    if (prismaCode.startsWith("P1")) return "DB_UNAVAILABLE";
    if (prismaCode === "ECONNREFUSED" || prismaCode === "ENOTFOUND") {
      return "SHOPIFY_UNAVAILABLE";
    }
  }

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
  if (text.includes("usererrors") || text.includes("invalid value")) {
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
