/**
 * Which pool this process gets: the web's, unless the process says it is the worker (#810).
 *
 * Declared in code rather than read from an environment variable, because the failure that
 * matters is the worker being mistaken for the web process -- a run's writes inheriting a
 * page's five-second statement timeout -- and an environment variable is exactly the kind
 * of thing a recreated Railway service loses (see the runbook's Config-as-Code note). The
 * worker's entry point declares itself before anything imports the database client, and
 * refuses to start if the client was built for anything else.
 *
 * The web process is the default because it has no single entry point to declare from: the
 * server bundle, `vite dev` and every script reach `db.server` through whatever imports it
 * first. Defaulting the other way would give every page the worker's pool.
 */

import type { ProcessRole } from "./pool";

let declared: ProcessRole | undefined;

/**
 * Says which process this is. Must run before `db.server` is first imported -- the client
 * is built at import -- which is why the worker does it from a module of its own, imported
 * first (`app/worker/as-worker.ts`).
 */
export function declareProcessRole(role: ProcessRole): void {
  declared = role;
}

/** The role this process declared, or the web's. */
export function processRole(): ProcessRole {
  return declared ?? "web";
}
