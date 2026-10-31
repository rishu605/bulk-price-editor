/**
 * The scheduler saying it is alive, and anything else asking whether it is.
 *
 * This is the signal behind the one alert that catches a dead worker. Every other alert
 * is computed from work the worker produces — webhook lag from processed deliveries,
 * error rate from a denominator of those same deliveries — so a worker that stops
 * outright empties all of them and they go quiet rather than fire. Only absence of a
 * heartbeat distinguishes "nothing is happening because nothing needs to" from "nothing
 * is happening because the process is gone".
 *
 * Stamped more than once per tick on purpose. A tick can spend minutes inside a single
 * large campaign, and a heartbeat written only at the top would go stale during exactly
 * the work that proves the scheduler is alive — reporting a stopped scheduler because it
 * was busy. So the tick beats when it starts and again as it works through campaigns.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";

/** The only legal primary key. See the model comment. */
const SINGLETON = "singleton";

/**
 * Records that the scheduler is alive at `now`.
 *
 * Never throws. This is liveness reporting, and a failure to report is not worth failing
 * the tick that was about to do the real work — the worst case is one missed beat, and
 * the next one is thirty seconds away.
 */
export async function beat(now: Date = new Date(), instance?: string): Promise<void> {
  try {
    await prisma.schedulerHeartbeat.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, beatAt: now, instance: instance ?? null },
      update: { beatAt: now, instance: instance ?? null },
    });
  } catch (error) {
    logger.warn("could not stamp the scheduler heartbeat", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * How long since the scheduler last said anything, or null if it never has.
 *
 * Null rather than a large number on a fresh install, because "we have not looked" and
 * "we looked and it is dead" are different statements and only one of them should wake
 * somebody. Alerting treats null as "do not know" and stays quiet.
 *
 * **"Now" is read after the query, not before it (#813).** It used to be a default
 * parameter, evaluated at the call -- so `/healthz`, whose query waited 6.8-10.4 s for a
 * pooled connection on 25 Sep, measured from a moment several seconds before it read the
 * row, and a beat stamped during that wait came out as a negative age. A caller asking
 * about a particular moment still passes one; nothing else should.
 */
export async function secondsSinceBeat(now?: Date): Promise<number | null> {
  const row = await prisma.schedulerHeartbeat.findUnique({
    where: { id: SINGLETON },
    select: { beatAt: true },
  });

  if (!row) return null;
  return secondsBetween(row.beatAt, now ?? new Date());
}

/**
 * Whole seconds from a beat to `now`, never below zero.
 *
 * The beat is stamped by the worker's clock and read against this process's, and a caller
 * may pass a `now` from before its own query. Either way a beat "after now" is a scheduler
 * that is alive at now -- zero, the freshest an age can be -- not one that beats in the
 * future, which every consumer of this number would misread.
 */
export function secondsBetween(beatAt: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - beatAt.getTime()) / 1000));
}
