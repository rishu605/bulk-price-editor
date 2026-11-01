/**
 * Answering Shopify Flow the way Flow reads an answer (#773).
 *
 * Flow's action contract: it waits at most **ten seconds** for a status; a 4xx (other
 * than 429) is a failure it shows and does not resend; a 5xx is resent at increasing
 * intervals for up to **36 hours**. The three actions broke all three halves of that:
 * they ran campaigns sized for Railway's five minutes inside Flow's ten seconds, answered
 * 200 to a refusal -- a green run log for something that never happened -- and let a
 * deterministic throw become a 5xx that Flow then repeated for a day and a half.
 *
 * So: every price write and every capture Flow asks for goes to the worker, whatever its
 * size (D29, #808), and Flow hears 200 once it is queued; a refusal is a 4xx naming the
 * campaign and the reason; only a failure that can clear on its own is a 5xx or 429; and
 * every request, refused or not, leaves an activity entry, so "what did Flow ask for?" is
 * answerable from inside Anchor.
 */

import prisma from "../../db.server";
import { FLOW_ACTOR } from "../../lib/audit/actor";
import { EDITS_WILL_BE_LEFT, editsLeft } from "../../lib/campaigns/kept-edits";
import { toAppError } from "../../lib/errors/app-error";
import { countOf, formatCount } from "../../lib/format/display";
import { logger } from "../../lib/logging/logger";
import type { RunOutcome } from "../campaigns/types";

/** Kept beside the scheduler's, because the run tells the two apart from a person (#1009). */
export { FLOW_ACTOR };

export interface FlowAnswer {
  status: number;
  message: string;
  /** For the activity entry: what happened, in one word. */
  outcome: "done" | "queued" | "partial" | "refused" | "retry" | "not-found";
}

/** The answer for a campaign run, from its outcome. */
export function answerForRun(outcome: RunOutcome, campaignName: string, verb: "applied" | "ended"): FlowAnswer {
  // What an end did with the prices edited outside Anchor, which End campaign keeps (#794): a
  // run here counts them, and one handed to the worker finds them when it runs.
  const kept = outcome.keptEdits ?? 0;
  const edits = kept > 0 ? ` ${editsLeft(kept)} The campaign's Ledger tab lists ${kept === 1 ? "it" : "them"}.` : "";
  if (outcome.queued) {
    return {
      status: 200,
      outcome: "queued",
      message: `"${campaignName}": ${outcome.messages[0] ?? "handed to the background worker."}` + (verb === "ended" ? ` ${EDITS_WILL_BE_LEFT}` : ""),
    };
  }
  // Will clear on its own -- a single-variant change in the way (#763), the worker's queue
  // unreachable -- so Flow's resend is exactly the retry it needs.
  if (outcome.refused && outcome.transient) {
    return { status: 503, outcome: "retry", message: `"${campaignName}": ${outcome.refused}` };
  }
  // Another run of this same occurrence is already doing the work: the work is being done.
  if (outcome.deferredTo) {
    return { status: 200, outcome: "done", message: `"${campaignName}" is already being ${verb === "applied" ? "applied" : "reverted"} by another run.` };
  }
  if (outcome.refused) {
    return { status: 422, outcome: "refused", message: `"${campaignName}" was not ${verb}: ${outcome.refused}` };
  }
  if (!outcome.clean) {
    // The run happened and is visibly partial in Anchor, where it can be resumed. Not a
    // 5xx: Flow resending it would start the whole run again rather than resume it.
    return {
      status: 200,
      outcome: "partial",
      message: `"${campaignName}" ${verb} with ${formatCount(outcome.failed)} failed and ${formatCount(outcome.unverified)} unverified. Resume it from the campaign page.${edits}`,
    };
  }
  if (kept > 0) {
    return { status: 200, outcome: "done", message: `"${campaignName}" ${verb}: ${countOf(outcome.verified, "variant")} reverted and verified.${edits}` };
  }
  return { status: 200, outcome: "done", message: `"${campaignName}" ${verb}: ${countOf(outcome.verified, "variant")}, all verified.` };
}

/**
 * The answer for a throw.
 *
 * Only what can clear on its own is resent: Shopify throttling us (429), Shopify or our
 * database unavailable (503). Everything else -- a state the campaign cannot move from, a
 * guardrail, a fault nobody has classified -- would fail identically for 36 hours, so it
 * is a 4xx Flow shows the merchant once.
 */
export function answerForError(error: unknown, subject: string): FlowAnswer {
  const app = toAppError(error);
  if (app.code === "SHOPIFY_THROTTLED") return { status: 429, outcome: "retry", message: `${subject}: ${app.userMessage}` };
  if (app.retryable) return { status: 503, outcome: "retry", message: `${subject}: ${app.userMessage}` };
  return {
    status: app.status >= 400 && app.status < 500 && app.status !== 429 ? app.status : 422,
    outcome: "refused",
    message: `${subject}: ${app.userMessage}`,
  };
}

/** The HTTP response, with the message Flow shows in its run log. */
export function respond(answer: FlowAnswer): Response {
  return new Response(JSON.stringify({ message: answer.message }), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The activity entry every Flow request leaves, refused or not.
 *
 * Best effort: failing to write the log must not change the answer Flow gets.
 */
export async function recordFlowRequest(
  shopId: string,
  action: "start-campaign" | "end-campaign" | "capture-baselines",
  entity: { kind: "Campaign" | "Segment"; id: string },
  answer: FlowAnswer,
): Promise<void> {
  try {
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: FLOW_ACTOR,
        action: `flow.${action}`,
        entity: entity.kind,
        entityId: entity.id || "(none)",
        after: { outcome: answer.outcome, status: answer.status, message: answer.message } as never,
      },
    });
  } catch (error) {
    logger.warn("could not record a Flow request", {
      shopId,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
