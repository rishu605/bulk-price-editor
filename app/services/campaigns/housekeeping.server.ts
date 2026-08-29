/**
 * The three things a merchant does to a campaign as an object rather than as a run:
 * copy it, say why it exists, and file it away.
 *
 * All three are here rather than in the route because all three write, and the route is
 * already the longest file in the app. They share a shape too: each one is a small
 * mutation plus an audit entry, and none of them touches a price. Nothing in this file
 * may write to `variant_changes` or call the Admin API.
 */

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { copyName } from "../../lib/campaigns/copy-name";
import { logger } from "../../lib/logging/logger";

/**
 * Everything that describes what a campaign *does*, and nothing about what it *did*.
 *
 * This list is the whole feature, so it is worth being explicit about both halves.
 *
 * Copied: the rule, the scope, the surfaces, the compare-at and guardrail policies, the
 * rounding profile, the tag kit, the exclusions and the note. A duplicate that dropped
 * any of these would be a campaign that quietly prices differently from the one it was
 * copied from, which is worse than no duplicate at all.
 *
 * Not copied, and this is the point of the feature: `status` (a copy is a draft),
 * `schedule`/`startAt`/`endAt` (last month's dates are never the dates the merchant
 * wants — leaving them would schedule a run in the past), `enrollPendingAt`, the runs,
 * and the ledger. History belongs to the campaign that made it. A duplicate carrying its
 * source's run history would be a lie about what has been written to the storefront, and
 * this app's entire proposition is that the record is true.
 */
const COPIED = {
  name: true,
  priority: true,
  ruleRows: true,
  surfaces: true,
  compareAtPolicy: true,
  compareAtViolationPolicy: true,
  roundingProfileId: true,
  guardrails: true,
  guardrailViolationPolicy: true,
  tagKit: true,
  autoEnroll: true,
  excludedVariantGids: true,
  note: true,
} as const;

export async function duplicateCampaign(
  shopId: string,
  campaignId: string,
  actor: string | null,
): Promise<{ id: string; name: string }> {
  const source = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { ...COPIED, segments: { select: { id: true } } },
  });

  // Every name in the shop, not just the unarchived ones. A copy that collides with an
  // archived campaign's name makes the archive unreadable later, and reading a few
  // thousand short strings is cheaper than the query that would avoid it.
  const taken = await prisma.campaign.findMany({ where: { shopId }, select: { name: true } });

  const { segments, ruleRows, surfaces, compareAtPolicy, guardrails, ...fields } = source;

  const copy = await prisma.campaign.create({
    data: {
      ...fields,
      // The Json columns come back as `JsonValue`, which includes `null`, and Prisma's
      // create input wants `DbNull` for a null Json column -- passing the read value
      // straight through does not typecheck and, worse, `null` on a required Json column
      // would mean "JSON null" rather than "no value". Only `guardrails` is nullable, so
      // only it can take the null branch.
      ruleRows: ruleRows as Prisma.InputJsonValue,
      surfaces: surfaces as Prisma.InputJsonValue,
      compareAtPolicy: compareAtPolicy as Prisma.InputJsonValue,
      guardrails: guardrails === null ? Prisma.DbNull : (guardrails as Prisma.InputJsonValue),
      shopId,
      name: copyName(source.name, taken.map((c) => c.name)),
      status: "DRAFT",
      createdBy: actor,
      // Connected, not copied. A segment is a saved definition shared across campaigns;
      // duplicating the rows would give the copy a segment that stops tracking the
      // original the first time the merchant edits either one.
      segments: { connect: segments.map((s) => ({ id: s.id })) },
    },
    select: { id: true, name: true },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor,
      action: "campaign.duplicate",
      entity: "campaign",
      entityId: copy.id,
      after: { from: campaignId, name: copy.name } as never,
    },
  });

  logger.info("campaign duplicated", { shopId, from: campaignId, to: copy.id });
  return copy;
}

/**
 * Out of the list, still in the record.
 *
 * Archiving is deliberately allowed in any state, including ACTIVE. A merchant filing a
 * running campaign away has made a filing decision, not a pricing one, and refusing it
 * would only teach them that archive is unreliable. The campaign keeps running, the
 * scheduler keeps seeing it — `archivedAt` is read by the index and by nothing else.
 */
export async function setArchived(
  shopId: string,
  campaignId: string,
  archived: boolean,
  actor: string | null,
): Promise<{ name: string }> {
  const campaign = await prisma.campaign.update({
    // `updateMany`-style scoping through `where` would be safer against a wrong shop,
    // but `update` cannot take a compound where here, so the shop is checked first.
    where: { id: (await ownedCampaign(shopId, campaignId)).id },
    data: { archivedAt: archived ? new Date() : null },
    select: { name: true },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor,
      action: archived ? "campaign.archive" : "campaign.unarchive",
      entity: "campaign",
      entityId: campaignId,
      after: { name: campaign.name } as never,
    },
  });

  return campaign;
}

/**
 * Why this campaign exists, in the merchant's own words.
 *
 * The before value is recorded because a note is the one field on a campaign whose
 * previous contents are not recoverable from anything else — the ledger reconstructs
 * every price we wrote, and nothing reconstructs a sentence somebody replaced.
 */
export async function setNote(
  shopId: string,
  campaignId: string,
  note: string,
  actor: string | null,
): Promise<{ note: string | null }> {
  const before = await ownedCampaign(shopId, campaignId);
  const trimmed = note.trim();

  const updated = await prisma.campaign.update({
    where: { id: before.id },
    // Empty is no note, not an empty one. A blank string would render as a note the
    // merchant has to look at twice to see is empty.
    data: { note: trimmed === "" ? null : trimmed },
    select: { note: true },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor,
      action: "campaign.note",
      entity: "campaign",
      entityId: campaignId,
      before: { note: before.note } as never,
      after: { note: updated.note } as never,
    },
  });

  return updated;
}

/** Refuses a campaign belonging to another shop before anything is written. */
async function ownedCampaign(shopId: string, campaignId: string) {
  return prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { id: true, note: true },
  });
}

/**
 * The three intents, dispatched in one place.
 *
 * The campaign route's action is already the longest in the app and every branch of it
 * writes prices. These three do not touch a price, so they are answered before that
 * machinery is reached and the route stays four lines longer rather than forty.
 *
 * Returns null for anything it does not recognise, so the caller can carry on to the
 * intents that do run campaigns. A returned object is the whole response.
 */
export async function housekeepingAction(
  shopId: string,
  campaignId: string,
  actor: string | null,
  form: { get(name: string): FormDataEntryValue | null },
): Promise<{ ok: true; message: string; redirectTo?: string } | null> {
  const intent = String(form.get("intent") ?? "");

  if (intent === "duplicate") {
    const copy = await duplicateCampaign(shopId, campaignId, actor);
    return {
      ok: true,
      message: `Copied to “${copy.name}”.`,
      // Onto the copy, because a merchant duplicates a campaign in order to change
      // something about it. Staying here would leave them looking at the original.
      redirectTo: `/app/campaigns/${copy.id}?duplicated=1`,
    };
  }

  if (intent === "archive" || intent === "unarchive") {
    const { name } = await setArchived(shopId, campaignId, intent === "archive", actor);
    return {
      ok: true,
      // Says what archiving did and did not do. The word means "deleted" to enough
      // people that leaving it unqualified is how a merchant learns to fear the button.
      message:
        intent === "archive"
          ? `“${name}” is archived. Its runs, its ledger and any prices it has live are unchanged.`
          : `“${name}” is back in the campaigns list.`,
    };
  }

  if (intent === "note") {
    const { note } = await setNote(shopId, campaignId, String(form.get("note") ?? ""), actor);
    return { ok: true, message: note ? "Note saved." : "Note cleared." };
  }

  return null;
}
