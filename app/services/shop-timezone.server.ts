/**
 * The store's time zone, read from Shopify rather than assumed (#799).
 *
 * `Shop.timezone` defaults to UTC, and its only writer used to be the catalogue sync. A
 * store that had not synced was UTC, and the campaign editor said so as a fact "from your
 * Shopify store settings": a 9 AM sale typed there opened at 4 AM in New York once the
 * first sync wrote the real zone. A zone changed later in Shopify reached Anchor only on
 * the next manual re-sync, and every schedule, calendar day and digest used the old one
 * until then.
 *
 * So the zone is asked of Shopify where it decides something: the editor reads it before
 * showing it and again before converting a typed time, and every authenticated visit
 * refreshes the stored copy that pages display with. A store whose zone cannot be read is
 * told so; a typed time is never converted in a zone Anchor guessed.
 */

import prisma from "../db.server";
import type { AdminClient } from "../lib/execution/sync-executor";
import { logger } from "../lib/logging/logger";
import { typedWindow, windowFromFields, type WindowFields } from "../lib/scheduling/window-input";
import { isTimeZone } from "../lib/scheduling/zone-shift";
import type { AnchorShopTimezoneQuery } from "../types/admin.generated";

export const SHOP_TIMEZONE_QUERY = `#graphql
  query AnchorShopTimezone {
    shop { ianaTimezone }
  }
`;

/** The store's IANA zone as Shopify has it, or null when Shopify did not say. */
export async function readShopTimezone(client: AdminClient): Promise<string | null> {
  try {
    const response = await client.request<AnchorShopTimezoneQuery>(SHOP_TIMEZONE_QUERY, {});
    const zone = response.data?.shop?.ianaTimezone;
    // A value Intl cannot convert in is no better than none: every time typed against it
    // would throw, or worse, be read in some other zone.
    if (isTimeZone(zone)) return zone;
    logger.warn("shop.timezone.unreadable", { answered: typeof zone === "string" });
    return null;
  } catch (error) {
    logger.warn("shop.timezone.unreadable", { reason: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Asks Shopify for the zone and records it. The zone, or null when Shopify did not answer
 * -- in which case nothing that converts a typed time may go ahead.
 */
export async function confirmShopTimezone(
  shopId: string,
  client: AdminClient,
  actor: string | null,
): Promise<string | null> {
  const zone = await readShopTimezone(client);
  if (zone) await recordShopTimezone(shopId, zone, actor);
  return zone;
}

/**
 * The phrase for a refusal when the zone could not be read, naming what was not done.
 * Every merchant-visible error names the object, the cause and the next action.
 */
export function unknownZoneMessage(field: "Start" | "End" | "Dates", outcome: string): string {
  return (
    `${field}: Anchor couldn't read your store's time zone from Shopify just now, so it can't ` +
    `tell when a time you type would be. ${outcome} Try again in a minute, or leave the dates ` +
    "empty and apply the campaign by hand."
  );
}

export type StoreWindow =
  | { ok: true; zone: string | null; startUtc: string | null; endUtc: string | null; clockNotes: string[] }
  | { ok: false; message: string };

/**
 * Typed dates as instants, read in the zone Shopify has for the store right now.
 *
 * The one reading for the editor and the edit-dates dialog. The zone is asked for only
 * when a date was typed, and a store whose zone cannot be read gets a refusal saying so,
 * ending with `outcome` ("Nothing was created."), never a conversion in a zone Anchor
 * guessed. `zone` is null when no date was typed; otherwise it is the zone to record with
 * the times.
 */
export async function windowInStoreZone(
  shopId: string,
  client: AdminClient,
  actor: string | null,
  fields: WindowFields,
  outcome: string,
): Promise<StoreWindow> {
  const typed = typedWindow(fields);
  if (!typed.startLocal && !typed.endLocal) {
    return { ok: true, zone: null, startUtc: null, endUtc: null, clockNotes: [] };
  }
  const zone = await confirmShopTimezone(shopId, client, actor);
  if (!zone) return { ok: false, message: unknownZoneMessage(typed.startLocal ? "Start" : "End", outcome) };
  return { ok: true, zone, ...windowFromFields(fields, zone) };
}

/**
 * Stores the zone Shopify gave, if it is new.
 *
 * Campaigns saved before the typed zone was recorded have their times stamped with the
 * zone the store row held until now, which is the zone they were converted in: the editor
 * always converted with the stored zone, and the stored zone only changes here. That is
 * what lets a sale typed for 09:00 on a store Anchor still had as UTC be shown, after this
 * corrects it to New York, as starting at 04:00 -- with the offer to keep 09:00 -- rather
 * than moving silently. Only campaigns with a time still ahead of them: nothing can be
 * done about the others.
 *
 * Conditional on the old value, so two visits that read the same change at once stamp
 * once: the second finds the row already moved and does nothing.
 */
export async function recordShopTimezone(
  shopId: string,
  zone: string,
  actor: string | null,
): Promise<{ changed: boolean; from: string | null }> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { timezone: true } });
  if (!shop || shop.timezone === zone) return { changed: false, from: shop?.timezone ?? null };
  const from = shop.timezone;

  const changed = await prisma.$transaction(async (tx) => {
    const moved = await tx.shop.updateMany({ where: { id: shopId, timezone: from }, data: { timezone: zone } });
    if (moved.count === 0) return false;

    await tx.$executeRaw`
      UPDATE "campaigns"
         SET "schedule" = jsonb_set("schedule", '{zone}', to_jsonb(${from}::text))
       WHERE "shopId" = ${shopId}
         AND "schedule"->>'kind' = 'window'
         AND ("schedule"->>'zone') IS NULL
         AND "status"::text IN ('SCHEDULED', 'ACTIVE', 'HELD', 'PARTIAL')
         AND ("startAt" > now() OR "endAt" > now())`;

    await tx.auditLogEntry.create({
      data: {
        shopId,
        actor,
        action: "settings.timezone",
        entity: "Shop",
        entityId: shopId,
        before: { timezone: from } as never,
        after: { timezone: zone, source: "Shopify" } as never,
      },
    });
    return true;
  });

  return { changed, from };
}

/** How long a visit's refresh holds for that store in this process. */
const REFRESH_EVERY_MS = 5 * 60_000;
const lastRefresh = new Map<string, number>();

/**
 * The refresh on an authenticated visit: read the zone and record it if it moved.
 *
 * Not awaited by the page. Loaders run side by side, so waiting here would not make this
 * visit's pages read the new zone -- it would only make every visit slower. The pages read
 * it from the next request; the editor never relies on it, because it reads the zone
 * itself. At most once per store every few minutes in a process: an action revalidates
 * every loader on the page, and one Shopify read per click is not worth anything.
 *
 * By domain, because the first visit after an install arrives before the shop row exists:
 * the page's own loader creates it while Shopify answers.
 */
export async function refreshShopTimezone(
  domain: string,
  client: AdminClient,
  actor: string | null,
  now: number = Date.now(),
): Promise<void> {
  const last = lastRefresh.get(domain);
  if (last !== undefined && now - last < REFRESH_EVERY_MS) return;
  lastRefresh.set(domain, now);

  try {
    const zone = await readShopTimezone(client);
    if (!zone) {
      // Asked again on the next visit rather than in five minutes.
      lastRefresh.delete(domain);
      return;
    }
    const shop = await prisma.shop.findUnique({ where: { domain }, select: { id: true } });
    if (shop) await recordShopTimezone(shop.id, zone, actor);
    else lastRefresh.delete(domain);
  } catch (error) {
    lastRefresh.delete(domain);
    logger.warn("shop.timezone.refresh_failed", { reason: error instanceof Error ? error.message : String(error) });
  }
}
