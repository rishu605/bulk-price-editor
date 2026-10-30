import { PrismaClient } from "@prisma/client";

import { connectionUrl, poolSettings, type PoolSettings } from "./lib/db/pool";
import { processRole } from "./lib/db/process-role";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

/**
 * The pool this process's client was built with: its role, its size and its timeouts.
 *
 * Exported so the boot check can log it and the worker can refuse to start on the web's
 * pool (#810). Read at import, because that is when the client is built -- a role declared
 * afterwards changes nothing, which is what the worker's check exists to catch.
 */
export const databasePool: PoolSettings = poolSettings(processRole());

/**
 * One client, with a pool size this app chose rather than inherited.
 *
 * See `lib/db/pool.ts` for where the numbers come from, why leaving them to Prisma's
 * CPU-derived default is a risk rather than a convenience, and why the web process and the
 * worker are sized and timed out apart (#810).
 */
function client(): PrismaClient {
  const url = connectionUrl(process.env.DATABASE_URL, databasePool);
  return url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = client();
  }
}

const prisma = global.prismaGlobal ?? client();

export default prisma;
