/**
 * Declares this process the worker, for its database pool (#810).
 *
 * A module of its own, imported first by `scripts/worker.ts`, because ES modules evaluate
 * their imports in order before the importing file's body runs: a call at the top of the
 * worker would come after `db.server` had already built the client with the web's pool.
 * Nothing here may import the database client, or the declaration would be too late again.
 */

import { declareProcessRole } from "../lib/db/process-role";

declareProcessRole("worker");
