import { PrismaClient } from "@prisma/client";

import { poolUrl } from "./lib/db/pool";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

/**
 * One client, with a pool size this app chose rather than inherited.
 *
 * See `lib/db/pool.ts` for where the number comes from and why leaving it to Prisma's
 * CPU-derived default is a risk rather than a convenience.
 */
function client(): PrismaClient {
  const url = poolUrl(process.env.DATABASE_URL, process.env.DATABASE_POOL_SIZE);
  return url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = client();
  }
}

const prisma = global.prismaGlobal ?? client();

export default prisma;
