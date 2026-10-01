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
 */

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { planRecapture } from "../services/recapture.server";
import { captureForFlow, captureRefusal } from "../services/flow/flow-capture.server";
import {
  answerForError,
  FLOW_INLINE_ROWS,
  recordFlowRequest,
  respond,
  type FlowAnswer,
} from "../services/flow/flow-answer.server";
import { enqueueWithin, webQueue } from "../worker/web-queue.server";
import { formatCount } from "../lib/format/display";

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
    const plan = await planRecapture(shopId, { segmentId });

    // Ten seconds is Flow's whole wait (#773). A capture larger than a run Flow may make
    // goes to the worker and is answered at once; with no worker queue it runs here.
    const queue = plan.variantGids.length > FLOW_INLINE_ROWS ? webQueue() : null;
    if (queue) {
      try {
        await enqueueWithin(queue, "sync", { shopId, recaptureSegmentId: segmentId });
      } catch {
        // The queue will come back; Flow resends a 5xx, which is the retry this needs.
        return {
          status: 503,
          outcome: "retry",
          message: "This capture is too large to run inside Flow's wait, and the background worker could not be reached. Nothing was captured; Flow will try again.",
        };
      }
      return {
        status: 200,
        outcome: "queued",
        message: `Capturing baselines for ${formatCount(plan.variantGids.length)} variants in the background.`,
      };
    }

    const captured = await captureForFlow(shopId, segmentId);
    return { status: 200, outcome: "done", message: `Captured baselines for ${formatCount(captured)} variants.` };
  } catch (error) {
    return answerForError(error, "Baselines were not captured");
  }
}
