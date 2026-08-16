/**
 * Per-shop rate-limit budget manager.
 *
 * The real GraphQL Admin limits are far tighter than they first appear: a
 * 1,000-point bucket restoring at 50 points/second on standard plans, 100/s on
 * Advanced, and a 2,000-point bucket at 100/s on Plus. A single variant update costs
 * roughly 100 points, so a standard shop sustains about one variant write every two
 * seconds synchronously. That arithmetic is why the bulk-operation path (which costs
 * nothing) is the default for anything sizeable, and why this manager is mandatory
 * rather than an optimisation.
 *
 * The bucket is mirrored from `extensions.cost.throttleStatus` on every response —
 * never hardcoded. We do not know the merchant's plan in advance, and guessing wrong
 * in either direction is bad: too high and we get throttled, too low and every run
 * crawls.
 *
 * A fraction of the budget is deliberately left unspent (`headroom`) for the
 * merchant's other apps. Under contention our runs slow down; they never 429 out
 * (edge case E17).
 */

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface QueryCost {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: ThrottleStatus;
}

export interface BudgetOptions {
  /** Fraction of the bucket we allow ourselves. Default 0.8 (`RATE_LIMIT_HEADROOM`). */
  headroom?: number;
  /**
   * Conservative starting assumption, replaced by the first observed
   * throttleStatus. Standard-plan values, since assuming the smallest bucket is the
   * safe direction to be wrong in.
   */
  initial?: ThrottleStatus;
  /** Injectable clock, so tests need not sleep in real time. */
  now?: () => number;
  /** Injectable sleep, likewise. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_INITIAL: ThrottleStatus = {
  maximumAvailable: 1_000,
  currentlyAvailable: 1_000,
  restoreRate: 50,
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimitBudget {
  private status: ThrottleStatus;
  private observedAt: number;
  private readonly headroom: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Serialises waiters so concurrent callers cannot each assume the whole bucket. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: BudgetOptions = {}) {
    this.status = options.initial ?? DEFAULT_INITIAL;
    this.headroom = options.headroom ?? 0.8;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? realSleep;
    this.observedAt = this.now();
  }

  /** Replaces the mirrored bucket with what Shopify just reported. */
  observe(cost: QueryCost | undefined): void {
    if (!cost?.throttleStatus) return;
    this.status = cost.throttleStatus;
    this.observedAt = this.now();
  }

  /** Points available now, projecting restore since the last observation. */
  available(): number {
    const elapsedSeconds = Math.max(0, (this.now() - this.observedAt) / 1000);
    const restored = elapsedSeconds * this.status.restoreRate;
    return Math.min(this.status.maximumAvailable, this.status.currentlyAvailable + restored);
  }

  /** The ceiling we hold ourselves to, leaving headroom for the merchant's other apps. */
  usableMaximum(): number {
    return this.status.maximumAvailable * this.headroom;
  }

  /** Milliseconds until `cost` points are affordable. Zero when already affordable. */
  waitMsFor(cost: number): number {
    const target = Math.min(cost, this.usableMaximum());
    const deficit = target - this.available();
    if (deficit <= 0) return 0;
    return Math.ceil((deficit / this.status.restoreRate) * 1000);
  }

  /**
   * Waits until `cost` points are affordable, then debits them optimistically.
   *
   * The debit is a local estimate; the next `observe` replaces it with the truth.
   * Estimating locally between responses is what stops a burst of concurrent calls
   * from all seeing a full bucket and firing at once.
   *
   * Calls are serialised: two callers reserving simultaneously queue rather than
   * both assuming the same points.
   */
  async reserve(cost: number): Promise<void> {
    const run = async () => {
      const waitMs = this.waitMsFor(cost);
      if (waitMs > 0) await this.sleep(waitMs);

      // Project the restore that just happened, then debit.
      const nowAvailable = this.available();
      this.status = {
        ...this.status,
        currentlyAvailable: Math.max(0, nowAvailable - cost),
      };
      this.observedAt = this.now();
    };

    const next = this.queue.then(run, run);
    // Swallow rejections on the chain so one failure cannot wedge every later waiter.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Current mirrored state, for metrics and diagnostics. */
  snapshot(): ThrottleStatus & { available: number; headroom: number } {
    return { ...this.status, available: this.available(), headroom: this.headroom };
  }
}

/** True when a GraphQL error payload represents throttling rather than a real fault. */
export function isThrottledError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    extensions?: { code?: string };
    message?: string;
    networkStatusCode?: number;
  };
  if (candidate.extensions?.code === "THROTTLED") return true;
  if (candidate.networkStatusCode === 429) return true;
  return typeof candidate.message === "string" && /throttl/i.test(candidate.message);
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1), so tests are deterministic. */
  random?: () => number;
}

/**
 * Exponential backoff with jitter for throttles and transient faults.
 *
 * Jitter matters more than it looks: without it, a run that trips the limit retries
 * every one of its chunks on the same schedule, re-colliding indefinitely.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === maxAttempts) throw error;
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      await sleep(Math.round(backoff * (0.5 + random() * 0.5)));
    }
  }
  throw lastError;
}
