#!/usr/bin/env tsx
/**
 * A campaign apply, in its own process, so the harness can kill it for real.
 *
 * Simulating worker death in-process is not the same test. `executeSync` catches per
 * product group, so an injected throw becomes an orderly per-row failure with reasons
 * attached -- a genuinely different ledger state from the one SIGKILL leaves behind,
 * where rows are committed but never attempted and nothing gets to run a catch block
 * or a finally. Proving resumption from *that* state is the point, and it needs a
 * process that can actually be killed.
 */

import prisma from "../../app/db.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { transitionCampaign } from "../../app/services/campaigns/lifecycle.server";
import { chaosAdminClient } from "./http-client";

async function main() {
  const endpoint = required("CHAOS_ENDPOINT");
  const shopId = required("CHAOS_SHOP_ID");
  const campaignId = required("CHAOS_CAMPAIGN_ID");
  const resume = process.env.CHAOS_RESUME === "1";

  await transitionCampaign(shopId, campaignId, "APPLYING", { reason: "chaos: child apply" });

  const outcome = await runCampaign(shopId, campaignId, chaosAdminClient(endpoint), {
    verifySampleRate: 1,
    resume,
  });

  // The parent reads this off stdout. Prefixed so it survives whatever else the
  // process logs on the way through.
  console.log(`CHAOS_OUTCOME ${JSON.stringify(outcome)}`);
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`apply-child: missing ${key}`);
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
