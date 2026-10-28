/**
 * Telling the merchant what happened while they were not watching.
 *
 * A campaign over a real catalogue runs for hours. If the only way to learn the
 * outcome is to keep the tab open, the app has quietly made itself something you have
 * to babysit — and the merchant who closes the laptop finds out about a partial run
 * from a customer.
 *
 * Two things are deliberate:
 *
 *   Unconfigured is a no-op, not an error. Local development and self-hosted installs
 *   have no Resend key, and a run that failed because it could not send an email about
 *   succeeding would be a genuinely absurd way to lose a price change.
 *
 *   Sending never fails a run. The email is a report on work that already happened;
 *   the ledger is the record. Throwing here would discard a successful campaign over
 *   an SMTP hiccup.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { compose, type Notification } from "../lib/notifications/templates";
import { campaignUrl, driftUrl } from "../lib/notifications/campaign-link";
import { preferenceFor, switchedOn } from "../lib/notifications/choices";
import {
  deliveryEntry,
  NOTIFICATION_DELIVERY,
  readDelivery,
  type Delivery,
  type DeliveryOutcome,
} from "../lib/notifications/delivery";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface DeliveryResult {
  sent: boolean;
  /** Why nothing was sent, when nothing was. Never an error the caller must handle. */
  reason?: Exclude<DeliveryOutcome, "sent">;
  /** Where it went, or would have gone. */
  to?: string;
  /** The mail provider's HTTP status, when it refused. */
  status?: number;
}

/**
 * Whether this install can send email at all.
 *
 * One function, because two places ask: `notify`, which gives up without it, and Settings,
 * which says so to the merchant. Each used to read the environment itself, and the page
 * could then promise what the sender would not do.
 */
export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM_EMAIL);
}

/** Which notifications a shop wants. Stored alongside the other shop settings. */
export interface NotificationPreferences {
  /** Where to send. Empty means notifications are effectively off. */
  email: string | null;
  onCompletion: boolean;
  onPartialOrFailure: boolean;
  onDrift: boolean;
  onRevert: boolean;
  weeklyDigest: boolean;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  email: null,
  // The ones that need a decision default on; the purely-good-news one defaults off.
  // A merchant who is emailed about every successful run stops reading the emails,
  // and then misses the partial one that mattered.
  onCompletion: false,
  onPartialOrFailure: true,
  onDrift: true,
  onRevert: true,
  weeklyDigest: false,
};

export function parsePreferences(raw: unknown): NotificationPreferences {
  const value = (raw ?? {}) as Partial<Record<keyof NotificationPreferences, unknown>>;
  const bool = (key: keyof NotificationPreferences, fallback: boolean) =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : fallback;

  const email = typeof value.email === "string" ? value.email.trim() : "";

  return {
    email: email.includes("@") ? email : null,
    onCompletion: bool("onCompletion", DEFAULT_PREFERENCES.onCompletion),
    onPartialOrFailure: bool("onPartialOrFailure", DEFAULT_PREFERENCES.onPartialOrFailure),
    onDrift: bool("onDrift", DEFAULT_PREFERENCES.onDrift),
    onRevert: bool("onRevert", DEFAULT_PREFERENCES.onRevert),
    weeklyDigest: bool("weeklyDigest", DEFAULT_PREFERENCES.weeklyDigest),
  };
}

/** Where `writePreferences` records when the weekly digest was turned on, in the shop's settings. */
export const DIGEST_ENABLED_AT = "digestEnabledAt";

/** When the weekly digest was turned on, or null when that was never recorded. */
export function digestEnabledAt(settings: unknown): Date | null {
  const value = ((settings ?? {}) as Record<string, unknown>)[DIGEST_ENABLED_AT];
  const at = typeof value === "string" ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

export async function readPreferences(shopId: string): Promise<NotificationPreferences> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { settings: true } });
  const settings = (shop?.settings ?? {}) as { notifications?: unknown };
  return parsePreferences(settings.notifications);
}

export async function writePreferences(
  shopId: string,
  preferences: NotificationPreferences,
  /** Who changed them, so "who turned the emails off?" is answerable (#1119). */
  actor?: string,
): Promise<NotificationPreferences> {
  const parsed = parsePreferences(preferences);

  // Merged into the existing blob rather than replacing it. Guardrails live in the
  // same JSON column, and saving an email address must not quietly reset the floor
  // that stops a campaign pricing below cost.
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { settings: true },
  });

  // When the weekly digest was turned on (#713): the first one is a week after it, not on the
  // next tick, which sent a digest of the day it was switched on as an empty welcome.
  const settings = { ...((shop.settings ?? {}) as Record<string, unknown>) };
  const before = parsePreferences(settings.notifications);
  if (parsed.weeklyDigest && !before.weeklyDigest) settings[DIGEST_ENABLED_AT] = new Date().toISOString();
  if (!parsed.weeklyDigest) delete settings[DIGEST_ENABLED_AT];

  await prisma.shop.update({
    where: { id: shopId },
    data: { settings: { ...settings, notifications: parsed } as never },
  });

  // Only what moved, and only when something did, as the typed-confirmation thresholds do
  // (#818). Every guardrail save writes an entry; these never did, so nothing could say who
  // switched a merchant's emails off, or to which address they now go.
  const moved = (Object.keys(parsed) as (keyof NotificationPreferences)[]).filter((key) => before[key] !== parsed[key]);
  if (moved.length > 0) {
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: actor ?? null,
        action: "settings.notifications.update",
        entity: "Shop",
        entityId: shopId,
        before: Object.fromEntries(moved.map((key) => [key, before[key]])) as never,
        after: Object.fromEntries(moved.map((key) => [key, parsed[key]])) as never,
      },
    });
  }

  return parsed;
}

/** Whether this shop asked to hear about this kind of thing. */
export function wants(preferences: NotificationPreferences, notification: Notification): boolean {
  const key = preferenceFor(notification.kind);
  return key === null ? true : preferences[key];
}

/**
 * Sends one notification, if everything about it says to.
 *
 * Every path out of here is a resolved promise. Callers treat notification as
 * best-effort reporting, and nothing about a mail provider should be able to change
 * what happened to a merchant's prices.
 */
export async function notify(
  shopId: string,
  notification: Notification,
  /** The run it reports on, so the campaign page can say whether that run's email went (#1123). */
  context: { runId?: string } = {},
): Promise<DeliveryResult> {
  const result = await deliver(shopId, notification);
  await recordDelivery(shopId, notification, result, context.runId);
  return result;
}

async function deliver(shopId: string, notification: Notification): Promise<DeliveryResult> {
  try {
    if (!mailConfigured()) return { sent: false, reason: "unconfigured" };
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFICATION_FROM_EMAIL;

    const preferences = await readPreferences(shopId);
    if (!preferences.email) return { sent: false, reason: "no-recipient" };
    if (!wants(preferences, notification)) return { sent: false, reason: "muted", to: preferences.email };

    const email = compose(await withLink(shopId, notification));

    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [preferences.email],
        subject: email.subject,
        text: email.text,
      }),
    });

    if (!response.ok) {
      // Logged with the kind and status, never the body: the body is the email, and
      // logs are one more place a merchant's business shows up unnecessarily.
      logger.warn("notification not delivered", {
        shopId,
        kind: notification.kind,
        status: response.status,
      });
      return { sent: false, reason: "failed", to: preferences.email, status: response.status };
    }

    logger.info("notification sent", { shopId, kind: notification.kind });
    return { sent: true, to: preferences.email };
  } catch (error) {
    logger.warn("notification threw", {
      shopId,
      kind: notification.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, reason: "failed" };
  }
}

/**
 * The deep link, added here rather than at the call sites.
 *
 * Three places send notifications and each one already knows the campaign, so passing the
 * URL along would have worked — right up until the fourth. This is the shape of bug this
 * repo keeps finding: two halves of a contract, and only a third party ever checks they
 * agree. Building the link where the shop is already being read means a caller cannot
 * forget it, and a new kind of notification gets one for free.
 *
 * A shop that has somehow lost its domain, or an install with no API key, produces no
 * link and one line fewer in the email. See `campaign-link.ts` for why a guess is worse.
 */
async function withLink(shopId: string, notification: Notification): Promise<Notification> {
  if (notification.kind === "weekly-digest" || notification.kind === "test") return notification;

  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
  if (!shop) return notification;

  // eslint-disable-next-line no-undef
  const apiKey = process.env.SHOPIFY_API_KEY;
  const url =
    notification.kind === "drift-hold"
      ? driftUrl(shop.domain, apiKey)
      : campaignUrl(shop.domain, notification.campaignId, apiKey);

  return { ...notification, campaignUrl: url };
}

/**
 * Keeps what happened to one email (#1121): sent, or which of the reasons it was not.
 *
 * Best-effort like the send. A record that cannot be written is logged and dropped; it
 * must never become the reason a run, or the email it reports on, failed.
 */
async function recordDelivery(
  shopId: string,
  notification: Notification,
  result: DeliveryResult,
  runId: string | undefined,
): Promise<void> {
  try {
    const campaignId = "campaignId" in notification ? notification.campaignId : null;
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        action: NOTIFICATION_DELIVERY,
        entity: campaignId ? "campaign" : "shop",
        entityId: campaignId ?? shopId,
        after: deliveryEntry(notification, result.sent ? "sent" : (result.reason ?? "failed"), {
          to: result.to,
          status: result.status,
          runId,
        }) as never,
      },
    });
  } catch (error) {
    logger.warn("notification outcome not recorded", {
      shopId,
      kind: notification.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The shop's most recent email outcomes, newest first. */
export async function recentDeliveries(shopId: string, take = 25): Promise<Delivery[]> {
  const entries = await prisma.auditLogEntry.findMany({
    where: { shopId, action: NOTIFICATION_DELIVERY },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: { after: true, createdAt: true },
  });
  return entries.flatMap((entry) => readDelivery(entry.after, entry.createdAt) ?? []);
}

/**
 * A campaign's runs' email outcomes, by run id, from `since` -- the oldest run being shown,
 * so the read is bounded by the runs on the page rather than by a count. The newest wins
 * if a run has two.
 */
export async function deliveriesByRun(shopId: string, campaignId: string, since: Date): Promise<Map<string, Delivery>> {
  const entries = await prisma.auditLogEntry.findMany({
    where: { shopId, action: NOTIFICATION_DELIVERY, entityId: campaignId, createdAt: { gte: since } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { after: true, createdAt: true },
  });
  const byRun = new Map<string, Delivery>();
  for (const entry of entries) {
    const delivery = readDelivery(entry.after, entry.createdAt);
    if (delivery?.runId) byRun.set(delivery.runId, delivery);
  }
  return byRun;
}

/** How long a shop waits between test emails. */
export const TEST_EMAIL_INTERVAL_MS = 30_000;

/**
 * Sends a test to the saved address, from Settings (#1122), and says what happened.
 *
 * Through `notify`, so it proves the path real notifications take -- same sender, same
 * provider, same record -- rather than a second path that could work while the first does
 * not. One per shop per thirty seconds: the button is the one way a merchant can make
 * Anchor send mail on demand.
 */
export async function sendTestEmail(shopId: string, shopName: string): Promise<{ ok: boolean; message: string }> {
  const recent = await prisma.auditLogEntry.findFirst({
    where: {
      shopId,
      action: NOTIFICATION_DELIVERY,
      entity: "shop",
      createdAt: { gte: new Date(Date.now() - TEST_EMAIL_INTERVAL_MS) },
      after: { path: ["kind"], equals: "test" },
    },
    select: { id: true },
  });
  if (recent) {
    return { ok: false, message: "A test email was sent less than 30 seconds ago. Give it a minute to arrive before sending another." };
  }

  const preferences = await readPreferences(shopId);
  const result = await notify(shopId, { kind: "test", shopName, switchedOn: switchedOn(preferences) });
  return { ok: result.sent, message: testEmailMessage(result) };
}

export function testEmailMessage(result: DeliveryResult): string {
  if (result.sent) return `Sent to ${result.to}. It should arrive within a minute; if it doesn't, check spam.`;
  switch (result.reason) {
    case "no-recipient":
      return "Save an address first. A test goes to the saved address.";
    case "unconfigured":
      return "Anchor can't send email right now, so nothing was sent. This is on our side, not a setting you've missed.";
    case "failed":
      return `The mail provider refused it${result.status ? ` (status ${result.status})` : ""}, so nothing was sent. Check the address and try again.`;
    default:
      return "Nothing was sent.";
  }
}
