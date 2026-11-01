/**
 * The one way a route starts an apply, a revert or a resume (D29, #808).
 *
 * A route never calls `runCampaign` itself. It says who is asking -- the campaign page or
 * Shopify Flow -- and this sets what that caller may write while it waits: the page, a run of
 * at most `MAX_INLINE_ROWS` variants inside its time budget; Flow, nothing. Anything else is
 * handed to the worker as a QUEUED run row before the request answers (`queueRun`), after the
 * gates a merchant or Flow must hear about at once -- approval, plan, a start nobody confirmed
 * -- have had their say. `runCampaign` decides, from the limit this passes; a test holds that
 * no route reaches it, or the catalogue sync or the baseline capture, any other way.
 *
 * So a merchant's one-variant revert and App Review's few-variant apply and revert run here,
 * exactly as they always did, and a 100,000-variant apply is a row the page follows while the
 * worker writes it, in its own connection pool, where it cannot take another shop's pages down
 * with it (#803).
 */

import type { AdminClient } from "../../lib/execution/sync-executor";
import { NEVER_INLINE, PAGE_INLINE } from "../../lib/execution/inline-budget";
import { runCampaign, type RunOptions } from "./run.server";
import type { RunOutcome } from "./types";

/** Who is asking, which is what decides how much may be written before answering. */
export type RunCaller = "page" | "flow";

/** What a route may ask a run for: everything but the limit, which is the caller's. */
export type StartOptions = Omit<RunOptions, "inline" | "runId" | "queued" | "claimedFrom" | "claimUnrecorded" | "occurrenceKey">;

export async function startRun(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  caller: RunCaller,
  options: StartOptions,
): Promise<RunOutcome> {
  return runCampaign(shopId, campaignId, client, { ...options, inline: caller === "page" ? PAGE_INLINE : NEVER_INLINE });
}
