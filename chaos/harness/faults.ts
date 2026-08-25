/**
 * Fault rules: the part of the harness that does the breaking.
 *
 * A rule reads as a sentence -- "throttle the next twelve variant writes", "cut the
 * connection after two products" -- so a scenario states its break rather than
 * building bespoke mock plumbing for it.
 *
 * Rules are applied by the fake's HTTP server rather than by wrapping a client, for
 * one reason that matters: the scenarios that kill a worker run the engine in a
 * separate process, and a fault that lived in the parent's memory would not reach it.
 * Applying faults at the wire means every scenario breaks the engine the same way,
 * whichever side of a process boundary it is on.
 */

export type FaultKind = "throttled" | "network" | "server-error" | "timeout" | "auth-revoked";

export interface FaultRule {
  fault: FaultKind;
  /** Requests this rule considers. Defaults to every request. */
  match?: (query: string, variables: Record<string, unknown>) => boolean;
  /** Matching requests to let through before firing. */
  after?: number;
  /**
   * Fire on every Nth matching request rather than consecutively.
   *
   * A storm is not "the first twelve calls fail" -- consecutive failures exhaust one
   * row's retry budget and prove nothing about recovery. Striking every other request
   * models contention properly: each write is hit, each retry gets through, and the
   * run has to slow down rather than give up.
   */
  everyNth?: number;
  /** How many times to fire once armed. Defaults to firing forever. */
  times?: number;
}

/** Matches the variant-write mutation, on either write path. */
export const isVariantWrite = (query: string) => query.includes("productVariantsBulkUpdate");

/** Matches the read-back verification query. */
export const isReadBack = (query: string) => query.includes("nodes(");

/** Matches a bulk-operation status poll. */
export const isBulkPoll = (query: string) => query.includes("currentBulkOperation");

export interface FaultResponse {
  /** HTTP status to answer with. */
  status: number;
  /** Body to answer with, or `"destroy"` to kill the socket outright. */
  body: Record<string, unknown> | "destroy";
}

/**
 * How each fault appears on the wire.
 *
 * These are Shopify's real shapes, not convenient ones. A throttle arrives as HTTP
 * 200 carrying `errors: {query: "Throttled"}`; a revoked token as a 401 whose message
 * is the string the classifier greps for. Inventing tidier shapes would mean the
 * suite exercised branches the production code never takes in the wild.
 */
export function wireShapeOf(kind: FaultKind): FaultResponse {
  switch (kind) {
    case "throttled":
      return { status: 200, body: { errors: { query: "Throttled" } } };
    case "network":
      // A destroyed socket, so the client sees a genuine ECONNRESET and undici
      // produces the literal "fetch failed" the classifier is written against.
      return { status: 0, body: "destroy" };
    case "server-error":
      return { status: 503, body: { errors: "Service Unavailable: internal error" } };
    case "timeout":
      return { status: 200, body: { errors: "ETIMEDOUT: request timed out" } };
    case "auth-revoked":
      return { status: 401, body: { errors: "Invalid API key or access token" } };
  }
}

interface ArmedRule extends FaultRule {
  seen: number;
  fires: number;
}

/** Evaluates rules against a request and reports which fault, if any, should fire. */
export class FaultBoard {
  private rules: ArmedRule[] = [];
  readonly fired = new Map<FaultKind, number>();
  passed = 0;

  arm(rules: FaultRule[]): void {
    this.rules = rules.map((rule) => ({ ...rule, seen: 0, fires: 0 }));
  }

  heal(): void {
    this.rules = [];
  }

  /**
   * Decides the fate of one request.
   *
   * Called before the request reaches the fake, so a fault means the write genuinely
   * did not happen. Deciding afterwards would leave the store changed while the
   * caller was told it failed -- the harness would then be manufacturing the very
   * divergence it exists to detect, and every verdict would be worthless.
   */
  consider(query: string, variables: Record<string, unknown>): FaultKind | null {
    for (const rule of this.rules) {
      if (rule.match && !rule.match(query, variables)) continue;

      rule.seen++;
      if (rule.seen <= (rule.after ?? 0)) continue;
      if (rule.fires >= (rule.times ?? Number.POSITIVE_INFINITY)) continue;
      if (rule.everyNth && (rule.seen - (rule.after ?? 0)) % rule.everyNth !== 0) continue;

      rule.fires++;
      this.fired.set(rule.fault, (this.fired.get(rule.fault) ?? 0) + 1);
      return rule.fault;
    }

    this.passed++;
    return null;
  }

  count(kind: FaultKind): number {
    return this.fired.get(kind) ?? 0;
  }
}
