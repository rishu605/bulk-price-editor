/**
 * "Put it back" on a price drift: the campaign's price, written now (#756).
 *
 * It used to mark the event REASSERTED and promise that "the campaign will rewrite this
 * price on its next run". For a manual campaign there is no next run, and a held one is
 * exactly what the scheduler skips -- so the merchant made the decision the app asked
 * for, the queue emptied, and the storefront kept the edit while the campaign stayed
 * Held for good.
 *
 * A write, so a run: the ordinary planner, ledger and read-back, scoped to the one
 * variant, the way reinstating a variant is. The run closes the drift event itself once
 * the price is written and read back (#755); nothing here marks it by hand, so the queue
 * can never say a price was put back when it was not.
 */

import prisma from "../../db.server";
import { AppError } from "../../lib/errors/app-error";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { releaseHold } from "./lifecycle.server";
import { runCampaign } from "./run.server";

/** States a campaign can be put back from: running, and not mid-run. */
const REASSERTABLE = new Set(["ACTIVE", "HELD", "PARTIAL"]);

export interface ReassertResult {
  ok: boolean;
  message: string;
}

export async function reassertDrift(
  shopId: string,
  eventId: string,
  client: AdminClient,
  actor?: string,
): Promise<ReassertResult> {
  const event = await prisma.driftEvent.findFirstOrThrow({ where: { id: eventId, shopId } });
  if (event.resolution !== "PENDING") {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        `This price drift was already resolved (${event.resolution.toLowerCase()}${event.resolvedBy ? ` by ${event.resolvedBy}` : ""}). ` +
        "Nothing was changed. Reload the page to see what is still waiting.",
    });
  }

  const campaign = event.campaignId
    ? await prisma.campaign.findFirst({
        where: { id: event.campaignId, shopId },
        select: { id: true, name: true, status: true },
      })
    : null;
  if (!campaign || !REASSERTABLE.has(campaign.status)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: campaign
        ? `"${campaign.name}" is ${campaign.status.toLowerCase()}, so it has no price to put back right now. ` +
          "Nothing was written. Choose Keep the change or Leave it for now, or try again once it has finished."
        : "The campaign that set this price no longer exists, so there is no price to put back. Nothing was written. " +
          "Choose Keep the change or Leave it for now.",
    });
  }

  const outcome = await runCampaign(shopId, campaign.id, client, {
    variantGids: [event.variantGid],
    verifySampleRate: 1,
    occurrenceKey: `VARIANT-REASSERT-${event.variantGid}-${Date.now()}`,
    actor,
  });

  const after = await prisma.driftEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: { resolution: true },
  });

  if (after.resolution === "PENDING") {
    if (outcome.refused || outcome.deferredTo) {
      return { ok: false, message: outcome.messages[0] ?? "Nothing was written. Try again in a moment." };
    }

    if (outcome.planned > 0) {
      // Written and not confirmed, or not written: the edit may still be live, so the
      // question stays open rather than being answered for the merchant.
      return {
        ok: false,
        message:
          `Couldn't put "${campaign.name}"'s price back: Shopify did not confirm the write. ` +
          "The drift stays in the queue so you can try again; the campaign's Ledger tab shows what happened.",
      };
    }

    // Nothing to write: the campaign no longer sets a different price for this variant --
    // it was excluded, or the storefront already shows the campaign's price. The merchant
    // asked for the campaign's price and has it, so the question is answered.
    await prisma.driftEvent.update({
      where: { id: eventId },
      data: { resolution: "REASSERTED", resolvedAt: new Date(), resolvedBy: actor ?? null },
    });
  }

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: actor ?? null,
      action: "drift.reassert",
      entity: "DriftEvent",
      entityId: eventId,
      after: { variantGid: event.variantGid, runId: outcome.runId || null, written: outcome.verified },
    },
  });

  const released = await releaseHold(shopId, campaign.id, actor);
  const running = released?.changed ? ` "${campaign.name}" is running again.` : "";

  return {
    ok: true,
    message:
      outcome.verified > 0
        ? `Put back: "${campaign.name}"'s price is on the storefront again, written and read back.${running}`
        : `"${campaign.name}" has no different price to write for this variant, so nothing was written. The drift is closed.${running}`,
  };
}
