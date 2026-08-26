/**
 * Gathering the signals, deciding what fires, and telling somebody.
 *
 * Operator alerts, not merchant notifications — a different audience and a different
 * channel. A merchant hears about *their* campaign; an operator hears that the scheduler
 * has stopped for everybody. Routing them to the same place would bury one in the other.
 *
 * Runs from the scheduler tick, which is slightly circular: the tick is what reports that
 * the tick is alive. That is fine for every condition except a stopped scheduler, and that
 * one is deliberately detected by *absence* — the tick writes a heartbeat and an external
 * check reads it, so a worker that has died cannot suppress its own alert by not running
 * the code that would send it.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { evaluate, type AlertCondition, type SignalWindow } from "../lib/observability/alerts";

/** How far back a window looks. Long enough to be meaningful, short enough to be current. */
const WINDOW_MINUTES = 15;

/** Not sent again inside this. An alert repeating every tick is an alert people mute. */
const REPEAT_AFTER_MINUTES = 60;

const lastSent = new Map<string, number>();

/**
 * Reads the signals a window needs.
 *
 * Every one comes from a table rather than from memory, so a restarted process does not
 * reset the picture — and so the same query can be run by hand when somebody is trying to
 * work out whether an alert was right.
 */
export async function gather(now: Date = new Date()): Promise<SignalWindow> {
  const since = new Date(now.getTime() - WINDOW_MINUTES * 60_000);

  const [lastRun, errors, webhooks, lastAudit] = await Promise.all([
    prisma.campaignRun.findFirst({
      where: { heartbeatAt: { not: null } },
      orderBy: { heartbeatAt: "desc" },
      select: { heartbeatAt: true },
    }),
    prisma.errorEvent.count({ where: { createdAt: { gte: since } } }),
    prisma.webhookEvent.findMany({
      where: { receivedAt: { gte: since }, processedAt: { not: null } },
      select: { receivedAt: true, processedAt: true },
      take: 500,
    }),
    prisma.auditLogEntry.findFirst({
      where: { action: "mirror.audited" },
      orderBy: { createdAt: "desc" },
      select: { after: true },
    }),
  ]);

  const lagMs = webhooks.length
    ? Math.max(
        ...webhooks.map((event) =>
          event.processedAt ? event.processedAt.getTime() - event.receivedAt.getTime() : 0,
        ),
      )
    : null;

  const audit = (lastAudit?.after ?? null) as
    | { rate?: number; unpriceable?: number }
    | null;

  return {
    // Null when nothing has ever run, which is a new install rather than a dead
    // scheduler. Alerting there would page somebody on every fresh deployment.
    secondsSinceTick: lastRun?.heartbeatAt
      ? Math.round((now.getTime() - lastRun.heartbeatAt.getTime()) / 1000)
      : null,
    webhookLagMs: lagMs,
    errors,
    // Webhook deliveries stand in for request volume: it is the traffic that arrives
    // whether or not a merchant has the app open, so it does not fall to zero overnight
    // and turn every error into a spike.
    requests: webhooks.length,
    divergenceRate: typeof audit?.rate === "number" ? audit.rate : null,
    // Null until an audit has run, for the same reason as the tick: "we have not looked"
    // and "we looked and found none" are different statements, and only one of them is
    // worth staying asleep over.
    unpriceableVariants: typeof audit?.unpriceable === "number" ? audit.unpriceable : null,
    executionQueueDepth: null,
  };
}

export interface AlertDelivery {
  fired: AlertCondition[];
  sent: number;
  suppressed: number;
}

/**
 * Evaluates and delivers.
 *
 * Never throws. An alerting system that can fail the thing it watches is worse than no
 * alerting system, because it fails at exactly the moment something else is already wrong.
 */
export async function checkAlerts(
  now: Date = new Date(),
  options: { queueDepth?: number | null } = {},
): Promise<AlertDelivery> {
  try {
    const window = await gather(now);
    if (options.queueDepth !== undefined) window.executionQueueDepth = options.queueDepth;

    const fired = evaluate(window);
    let sent = 0;
    let suppressed = 0;

    for (const alert of fired) {
      const last = lastSent.get(alert.id) ?? 0;
      if (now.getTime() - last < REPEAT_AFTER_MINUTES * 60_000) {
        suppressed += 1;
        continue;
      }

      lastSent.set(alert.id, now.getTime());
      await deliver(alert);
      sent += 1;
    }

    return { fired, sent, suppressed };
  } catch (error) {
    logger.error("alert check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { fired: [], sent: 0, suppressed: 0 };
  }
}

/**
 * Sends one alert.
 *
 * Logged at error regardless of whether email is configured, because the log is the sink
 * that always exists — and a deployment with no operator email should still have the alert
 * somewhere a person can find it.
 */
async function deliver(alert: AlertCondition): Promise<void> {
  logger.error(`ALERT ${alert.severity}: ${alert.title}`, {
    alert: alert.id,
    because: alert.because,
    runbook: alert.runbook,
  });

  const to = process.env.OPERATOR_ALERT_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_FROM_EMAIL;
  if (!to || !apiKey || !from) return;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        subject: `[${alert.severity}] ${alert.title}`,
        text: `${alert.because}\n\nRunbook: ${alert.runbook}`,
      }),
    });
  } catch (error) {
    logger.error("could not send an alert email", {
      alert: alert.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fires one alert on purpose, to prove the routing works.
 *
 * The acceptance criterion asks for a synthetic firing, and it is the right thing to ask
 * for: an alerting path is only known to work when somebody has watched it deliver. This
 * exists so that check is one command rather than a production incident.
 */
export async function fireSyntheticAlert(): Promise<void> {
  await deliver({
    id: "synthetic",
    severity: "notice",
    title: "Synthetic alert — routing test",
    because:
      "Somebody ran the alert routing test. If you are reading this, the path from a " +
      "condition to a human works. Nothing is wrong.",
    runbook: "docs/runbooks.md",
  });
}

/** Test seam: forgets what has been sent, so suppression can be tested from a clean state. */
export function resetAlertHistory(): void {
  lastSent.clear();
}
