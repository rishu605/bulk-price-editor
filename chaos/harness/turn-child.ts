#!/usr/bin/env tsx
/**
 * One turn of a chunked run (#809, D34), in its own process, so the harness can kill it for real.
 *
 * The turn a worker takes when a chunked run's job reaches it: the next chunk of the run's
 * ledger, sent as one bulk operation, read back and recorded. Killed after Shopify accepted that
 * operation and before the turn read it back, it leaves the state a worker restarted mid-run
 * leaves -- a run in its turn with nobody in it, its chunk's rows sent and unread -- which no
 * in-process stand-in can, since nothing gets to run a catch block or a finally.
 */

import prisma from "../../app/db.server";
import { continueChunkedRun } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "./http-client";

async function main() {
  const endpoint = required("CHAOS_ENDPOINT");
  const shopId = required("CHAOS_SHOP_ID");
  const runId = required("CHAOS_RUN_ID");

  const turn = await continueChunkedRun(shopId, runId, chaosAdminClient(endpoint));

  // The parent reads this off stdout, as it reads an apply's.
  console.log(`CHAOS_OUTCOME ${JSON.stringify(turn)}`);
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`turn-child: missing ${key}`);
  return value;
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("CHAOS_ERROR", error instanceof Error ? error.message : error);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
