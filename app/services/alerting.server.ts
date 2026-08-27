/**
 * Gathering the signals, deciding what fires, and telling somebody.
 *
 * Operator alerts, not merchant notifications — a different audience and a different
 * channel. A merchant hears about *their* campaign; an operator hears that the scheduler
 * has stopped for everybody. Routing them to the same place would bury one in the other.
 *
 * Runs from the scheduler tick, which is slightly circular: the tick is what reports that
 * the tick is alive. That is fine for every condition except a stopped scheduler, and that
 * one is detected by *absence* — the tick stamps `scheduler_heartbeat` and whoever reads
 * that row decides, so a worker that has died cannot suppress its own alert by not running
 * the code that would send it.
 *
 * That last part was a description rather than a fact until the heartbeat existed. The
 * window read the newest campaign-run heartbeat instead, which is produced by runs rather
 * than by the tick — so the alert fired on any shop quiet for three minutes and stayed
 * silent when the scheduler died mid-run.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { metric } from "../lib/telemetry/metrics";
import { evaluate, type AlertCondition, type SignalWindow } from "../lib/observability/alerts";
import { secondsSinceBeat } from "./scheduler-heartbeat.server";

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

  const [sinceTick, errors, webhooks, delivered, lastAudit, errorsByShop, deliveriesByShop] =
    await Promise.all([
    // The scheduler's own heartbeat, not a campaign run's.
    //
    // This used to read the newest `campaign_runs.heartbeatAt`, which is stamped by runs
    // while they execute — so it was wrong in both directions. On an idle shop, which is
    // the normal state, the newest one is hours old and "the scheduler has stopped" paged
    // for a scheduler that was fine. And a scheduler that died while a long run was still
    // stamping looked alive, which is the one case the alert exists for.
    secondsSinceBeat(now),
    prisma.errorEvent.count({ where: { createdAt: { gte: since } } }),
    // Sampled, and only ever used for the worst lag. The cap is why the count below is a
    // separate query rather than this array's length.
    prisma.webhookEvent.findMany({
      where: { receivedAt: { gte: since }, processedAt: { not: null } },
      select: { receivedAt: true, processedAt: true },
      take: 500,
    }),
    // The real denominator.
    //
    // This used to be `webhooks.length`, which is capped at 500 — while `errors` above is
    // an uncapped count. Past five hundred deliveries in a window the denominator stops
    // growing and the numerator does not, so the error rate climbs with traffic and the
    // alert fires because the platform is *busy*. A rate whose two halves are measured
    // differently is not a rate.
    prisma.webhookEvent.count({
      where: { receivedAt: { gte: since }, processedAt: { not: null } },
    }),
    prisma.auditLogEntry.findFirst({
      where: { action: "mirror.audited" },
      orderBy: { createdAt: "desc" },
      select: { after: true },
    }),
    // Counted rather than listed. The global pair above samples 500 deliveries because it
    // only needs the worst lag; a rate needs the whole denominator or it is not a rate.
    prisma.errorEvent.groupBy({
      by: ["shopId"],
      where: { createdAt: { gte: since }, shopId: { not: null } },
      _count: { _all: true },
    }),
    prisma.webhookEvent.groupBy({
      by: ["shopId"],
      where: { receivedAt: { gte: since }, processedAt: { not: null }, shopId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const lagMs = webhooks.length
    ? Math.max(
        ...webhooks.map((event) =>
          event.processedAt ? event.processedAt.getTime() - event.receivedAt.getTime() : 0,
        ),
      )
    : null;

  const deliveries = new Map(
    deliveriesByShop.map((group) => [group.shopId!, group._count._all] as const),
  );

  const audit = (lastAudit?.after ?? null) as
    | { rate?: number; unpriceable?: number }
    | null;

  return {
    // Null until the scheduler has beaten once, which is a new install rather than a
    // dead scheduler. Alerting there would page somebody on every fresh deployment.
    secondsSinceTick: sinceTick,
    webhookLagMs: lagMs,
    errors,
    // Webhook deliveries stand in for request volume: it is the traffic that arrives
    // whether or not a merchant has the app open, so it does not fall to zero overnight
    // and turn every error into a spike.
    requests: delivered,
    divergenceRate: typeof audit?.rate === "number" ? audit.rate : null,
    // Null until an audit has run, for the same reason as the tick: "we have not looked"
    // and "we looked and found none" are different statements, and only one of them is
    // worth staying asleep over.
    unpriceableVariants: typeof audit?.unpriceable === "number" ? audit.unpriceable : null,
    executionQueueDepth: null,
    // Only shops that produced errors can be spiking, so the error groups drive the list
    // and the delivery counts supply each denominator. A shop with deliveries and no
    // errors is healthy and does not need a row.
    shopRates: errorsByShop.map((group) => ({
      shopId: group.shopId!,
      errors: group._count._all,
      requests: deliveries.get(group.shopId!) ?? 0,
    })),
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

    // Reported whether or not it crosses the alert threshold. An SLO panel needs the
    // ordinary values to have any idea what abnormal looks like, and this one was named
    // in the runbook before anything emitted it — so an operator following the page went
    // looking for a graph that did not exist.
    if (window.webhookLagMs !== null) metric("webhook.lag_ms", window.webhookLagMs);

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
