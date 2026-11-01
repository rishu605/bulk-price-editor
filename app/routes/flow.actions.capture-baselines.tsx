/**
 * Flow asking us to capture baselines.
 *
 * The one action here with a sharp edge. A baseline is what every campaign computes from,
 * permanently — so capturing while a sale is running records the sale price as the new
 * normal, and every future discount comes off the discounted number.
 *
 * The app makes a merchant type a confirmation for exactly that reason. An automation
 * cannot type, so this refuses outright when a campaign is live rather than asking. A
 * scheduled automation that silently reset a merchant's reference prices mid-sale would be
 * the most expensive thing in this codebase.
 *
 * Every capture it asks for is the worker's (D29, #808): checked here, so a refusal is Flow's
 * 4xx at once, then queued and answered 200. A capture has no row of its own to wait on, so
 * when the queue cannot take it Flow hears a 503, and its resend is the retry it needs.
 */

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { planRecapture } from "../services/recapture.server";
import { captureRefusal } from "../services/flow/flow-capture.server";
import { answerForError, recordFlowRequest, respond, type FlowAnswer } from "../services/flow/flow-answer.server";
import { enqueueWithin, webQueue } from "../worker/web-queue.server";
import { formatCount } from "../lib/format/display";

/** How long Flow's request waits for Redis to take the capture: well inside Flow's ten seconds. */
const CAPTURE_ENQUEUE_TIMEOUT_MS = 2_000;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, payload } = await authenticate.flow(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    select: { id: true },
  });
  if (!shop) return new Response("Unknown shop", { status: 404 });

  const segmentId = String(
    (payload as { properties?: Record<string, unknown> }).properties?.["segment-id"] ?? "",
  );
  // The worker reads the wholesale prices' quantity ladders with the shop's session (#1092).
  const answer = await capture(shop.id, segmentId);
  await recordFlowRequest(shop.id, "capture-baselines", { kind: "Segment", id: segmentId }, answer);
  return respond(answer);
};

async function capture(shopId: string, segmentId: string): Promise<FlowAnswer> {
  // A 409, not the 200 it was: Flow showed a capture that never happened as a success.
  const refusal = await captureRefusal(shopId);
  if (refusal) return { status: 409, outcome: "refused", message: refusal };

  // `segment-id` is required in the manifest, so an empty one means the request did not
  // carry what we asked for -- a renamed field key, a hand-built call. Falling through
  // would hand `undefined` to recapture, which means *every* baseline in the shop rather
  // than one segment. The widest possible write is the worst available default.
  if (!segmentId) {
    return {
      status: 400,
      outcome: "refused",
      message: "No segment was given, so nothing was captured. Choose a segment in this Flow action.",
    };
  }

  try {
    // Planned here for its refusals -- a segment that is gone, an empty scope -- which Flow
    // hears now, as a 4xx, rather than never.
    const plan = await planRecapture(shopId, { segmentId });

    // Every capture is the worker's (D29): a baseline capture never runs in a web request. The
    // worker checks again before it writes (`captureForFlow`): a campaign may go live first.
    const queue = webQueue();
    try {
      if (!queue) throw new Error("no worker queue");
      await enqueueWithin(queue, "sync", { shopId, recaptureSegmentId: segmentId }, CAPTURE_ENQUEUE_TIMEOUT_MS);
    } catch {
      // The queue will come back; Flow resends a 5xx, which is the retry this needs.
      return {
        status: 503,
        outcome: "retry",
        message: "Baselines are captured by the background worker, and it could not be reached. Nothing was captured; Flow will try again.",
      };
    }
    return {
      status: 200,
      outcome: "queued",
      message: `Capturing baselines for ${formatCount(plan.variantGids.length)} variants in the background.`,
    };
  } catch (error) {
    return answerForError(error, "Baselines were not captured");
  }
}
