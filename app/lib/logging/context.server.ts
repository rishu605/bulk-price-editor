/**
 * The ids every log line inside a unit of work should carry, without every call site
 * being asked to remember them.
 *
 * `logger` already moved two rules off call sites and into `emit` — secrets and prices —
 * for the reason written there: a rule kept by everyone remembering lasts until somebody
 * adds a field in a hurry. Correlation is the same kind of rule and had not been moved.
 * Before this, one log line in the whole tree carried a `jobId`, so a failed job's own
 * handler output could not be filtered back to it.
 *
 * **Bound at the unit of work, not at the HTTP request.** Per CLAUDE.md rule 2 the web
 * process writes prices and does so inline, so a boundary around the request would cover
 * an inline Apply and miss the queued one that runs the identical code. `runCampaign` and
 * the job wrapper are the two places where a shop, a campaign, a run and a job are all
 * actually known, and binding there gives both processes the same fields.
 *
 * **This file is server-only and the logger does not import it.** `logger.ts` is
 * reachable from the browser through `lib/errors/report.ts`, so it holds a registration
 * slot instead and `node:async_hooks` never enters the client bundle. Installation
 * happens at import, and nothing can bind a context without importing this module — so
 * the slot cannot still be empty at the moment it is needed.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { installLogContext, type LogFields } from "./logger";

/** Ids only. Anything a call site would rather say once than on every line. */
export type LogContext = Pick<
  LogFields,
  "shop" | "shopId" | "campaignId" | "runId" | "jobId" | "route"
>;

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Runs `work` with these ids on every line it logs, directly or indirectly.
 *
 * Nesting **merges** with whatever is already bound rather than replacing it. A run
 * starting inside a job has to keep the job id: losing it there would break the exact
 * correlation this exists to provide, and the inner scope is the one that knows least
 * about how it was reached.
 */
export function withLogContext<T>(fields: LogContext, work: () => Promise<T>): Promise<T> {
  return storage.run({ ...storage.getStore(), ...defined(fields) }, work);
}

/**
 * Adds ids to the scope already running.
 *
 * For the id that is not known at the boundary. `runCampaign` binds the shop and the
 * campaign on entry, but the run id does not exist until the `campaign_runs` row is
 * created some way in — and everything logged after that point should carry it.
 *
 * Safe to mutate because `withLogContext` stores a fresh object per scope, so this
 * reaches that scope and its children and nothing else. A no-op when no scope is
 * running, rather than an error: a caller that gained an id is not the right place to
 * discover that nobody bound a context.
 */
export function addLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, defined(fields));
}

/** What is bound right now. Empty outside any scope. */
export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/**
 * Drops undefined values before they are merged.
 *
 * Without this, a boundary passing an optional id it does not have — `runId: ref.runId`
 * on a job that carries no run — would spread `runId: undefined` over an id an outer
 * scope had correctly bound, and erase it. Passing a key you have no value for should
 * mean "I have nothing to add", never "forget what you knew".
 */
function defined(fields: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as LogContext;
}

installLogContext(currentLogContext);
