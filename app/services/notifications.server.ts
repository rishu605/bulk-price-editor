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

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface DeliveryResult {
  sent: boolean;
  /** Why nothing was sent, when nothing was. Never an error the caller must handle. */
  reason?: "unconfigured" | "no-recipient" | "muted" | "failed";
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

export async function readPreferences(shopId: string): Promise<NotificationPreferences> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { settings: true } });
  const settings = (shop?.settings ?? {}) as { notifications?: unknown };
  return parsePreferences(settings.notifications);
}

export async function writePreferences(
  shopId: string,
  preferences: NotificationPreferences,
): Promise<NotificationPreferences> {
  const parsed = parsePreferences(preferences);

  // Merged into the existing blob rather than replacing it. Guardrails live in the
  // same JSON column, and saving an email address must not quietly reset the floor
  // that stops a campaign pricing below cost.
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { settings: true },
  });

  await prisma.shop.update({
    where: { id: shopId },
    data: { settings: { ...((shop.settings ?? {}) as object), notifications: parsed } as never },
  });

  return parsed;
}

/** Whether this shop asked to hear about this kind of thing. */
export function wants(preferences: NotificationPreferences, notification: Notification): boolean {
  switch (notification.kind) {
    case "run-completed":
      return preferences.onCompletion;
    case "run-partial":
    case "run-failed":
      return preferences.onPartialOrFailure;
    case "revert-completed":
      return preferences.onRevert;
    case "drift-hold":
      return preferences.onDrift;
    case "weekly-digest":
      return preferences.weeklyDigest;
  }
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
): Promise<DeliveryResult> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFICATION_FROM_EMAIL;
    if (!apiKey || !from) return { sent: false, reason: "unconfigured" };

    const preferences = await readPreferences(shopId);
    if (!preferences.email) return { sent: false, reason: "no-recipient" };
    if (!wants(preferences, notification)) return { sent: false, reason: "muted" };

    const email = compose(notification);

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
      return { sent: false, reason: "failed" };
    }

    logger.info("notification sent", { shopId, kind: notification.kind });
    return { sent: true };
  } catch (error) {
    logger.warn("notification threw", {
      shopId,
      kind: notification.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, reason: "failed" };
  }
}
