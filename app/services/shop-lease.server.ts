/**
 * One run, and one sync, per shop at a time (#809, D33).
 *
 * The worker took `execution` jobs in the order Redis held them, two at once for the whole
 * app, with nothing to say two were the same shop's. Two 100k-variant runs from one shop held
 * both slots, and every other shop's one-variant sale waited behind them; two runs of one shop
 * also spend one rate-limit budget, so each sees the other's throttle and backs off. BullMQ's
 * open-source edition has no groups, so the shop is held here instead, in Postgres: whatever
 * writes for a shop -- a worker's job, the tick with Redis down, a campaign page writing fifty
 * variants -- takes the shop's lease first, and anything that finds it held waits its turn.
 *
 * **A lease, not a lock.** A session's advisory lock would hold a pooled connection for as long
 * as the run lasts -- hours, on the bulk path -- and PgBouncer's transaction pooling cannot keep
 * one at all (#810). The lease is a row: taken by one conditional upsert, renewed by its holder
 * while it works, and free to anybody once it has expired. So a worker that dies holds its shop
 * for `SHOP_LEASE_TTL_MS` at most, which is when the reaper reclaims its run anyway. The
 * database's clock decides expiry, never a process's: two workers' clocks need not agree.
 *
 * **Two kinds, held apart.** `run` for anything that writes prices; `sync` for a catalogue sync
 * or a baseline capture, which Shopify runs as bulk queries counted apart from a run's bulk
 * mutation (#1081). A shop's sync waits for its last sync, never for its run: a revert waiting
 * behind an import is the one wait this topology exists to prevent (`queues.ts`).
 *
 * **A chunked run holds it from its first turn to its last (#809, D34).** Its turns are jobs of
 * their own, with other shops' work between them, and the shop must not go to another of its
 * runs meanwhile. So the job that plans it hands the lease to the run (`runHolder`) rather than
 * releasing it, each turn takes it back as the run, and the last gives it up. Between turns no
 * process renews it; the worker's tick does, as it rings the run waiting (`renewRunLease`).
 */

import { randomUUID } from "node:crypto";

import prisma from "../db.server";
import { processRole } from "../lib/db/process-role";
import { logger } from "../lib/logging/logger";
import { STALE_AFTER_MS } from "./campaigns/reaper.server";

export type LeaseKind = "run" | "sync";

/**
 * How long a lease outlives its holder's last renewal. The reaper's patience with a quiet run,
 * so a shop held by a worker that died is free at about the moment its run is reclaimed as
 * Partial -- and never sooner, when the run is only slow.
 */
export const SHOP_LEASE_TTL_MS = STALE_AFTER_MS;

/** How often a holder renews: five times a lifetime, so one missed renewal never loses it. */
export const LEASE_RENEW_EVERY_MS = Math.max(1_000, Math.floor(SHOP_LEASE_TTL_MS / 5));

/** A held lease. `release`, `keep` and `handOver` are each safe to call twice, and never throw. */
export interface ShopLease {
  holder: string;
  release(): Promise<void>;
  /**
   * Stops renewing it without giving it up: a chunked run's turn that ends with the run going on,
   * or that found another process already in the run's turn (#809, D34). Its expiry is pushed out
   * once, and from then on the tick renews it while the run waits.
   */
  keep(): Promise<void>;
  /**
   * Gives it to another holder rather than releasing it: the job that planned a chunked run hands
   * the shop to the run, whose turns take it back by its name (`runHolder`).
   */
  handOver(to: string): Promise<void>;
}

/** A holder name: which process, and a fresh id, so a release or renewal is only ever its own. */
export function leaseHolder(what: string): string {
  return `${processRole()}:${what}:${randomUUID()}`;
}

/**
 * The holder a chunked run keeps its shop under between turns (#809, D34): the run itself, not a
 * job or a process, so whichever worker takes its next turn takes the lease back by this name.
 */
export function runHolder(runId: string): string {
  return `run:${runId}`;
}

/**
 * Takes the shop's lease of this kind for `holder`, or returns null when somebody else holds
 * it and it has not expired. Renewed on a timer until released, so a run of any length keeps
 * it; the timer does not keep the process alive.
 *
 * One statement: an insert, or an update of an expired row -- or of this holder's own -- and
 * the row comes back only when this holder now has it. Two takers at once serialise on the
 * primary key, and the second sees the first's row and is refused.
 */
export async function takeShopLease(
  shopId: string,
  kind: LeaseKind,
  { holder = leaseHolder(kind), campaignId = null }: { holder?: string; campaignId?: string | null } = {},
): Promise<ShopLease | null> {
  const taken = await prisma.$queryRaw<Array<{ holder: string }>>`
    INSERT INTO "shop_leases" ("shopId", "kind", "holder", "campaignId", "acquiredAt", "expiresAt")
    VALUES (${shopId}, ${kind}, ${holder}, ${campaignId}, now(), now() + ${SHOP_LEASE_TTL_MS} * interval '1 millisecond')
    ON CONFLICT ("shopId", "kind") DO UPDATE
       SET "holder" = EXCLUDED."holder", "campaignId" = EXCLUDED."campaignId",
           "acquiredAt" = EXCLUDED."acquiredAt", "expiresAt" = EXCLUDED."expiresAt"
     WHERE "shop_leases"."expiresAt" < now() OR "shop_leases"."holder" = EXCLUDED."holder"
    RETURNING "holder"`;
  if (taken.length === 0) return null;

  const renewal = setInterval(() => void renew(shopId, kind, holder), LEASE_RENEW_EVERY_MS);
  renewal.unref?.();
  let released = false;
  // Once, whichever way this holder lets go of it.
  const letGo = () => {
    if (released) return false;
    released = true;
    clearInterval(renewal);
    return true;
  };
  return {
    holder,
    async release() {
      if (!letGo()) return;
      try {
        await prisma.shopLease.deleteMany({ where: { shopId, kind, holder } });
      } catch (error) {
        // Never thrown: the lease expires on its own, and a release failing must not replace
        // the outcome of the work it guarded.
        logger.warn("a shop lease was not released; it expires on its own", {
          shopId,
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async keep() {
      if (!letGo()) return;
      await renew(shopId, kind, holder);
    },
    async handOver(to) {
      if (!letGo()) return;
      try {
        const moved = await prisma.$executeRaw`
          UPDATE "shop_leases" SET "holder" = ${to}, "expiresAt" = now() + ${SHOP_LEASE_TTL_MS} * interval '1 millisecond'
           WHERE "shopId" = ${shopId} AND "kind" = ${kind} AND "holder" = ${holder}`;
        if (moved === 0) logger.error("a shop lease was lost before it could be handed over", { shopId, kind, holder, to });
      } catch (error) {
        // Never thrown, as a release is not: the run's first turn takes it back by name, or waits
        // for whoever took it once it expired.
        logger.warn("a shop lease was not handed over", { shopId, kind, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

/**
 * Keeps a chunked run's lease while the run waits for its next turn (#809, D34): no process holds
 * it then, so the worker's tick renews it as it rings the run. Nothing when somebody else holds
 * the shop now -- the lease expired first -- and the run's next turn waits for them.
 */
export async function renewRunLease(shopId: string, runId: string): Promise<boolean> {
  const renewed = await prisma.$executeRaw`
    UPDATE "shop_leases" SET "expiresAt" = now() + ${SHOP_LEASE_TTL_MS} * interval '1 millisecond'
     WHERE "shopId" = ${shopId} AND "kind" = 'run' AND "holder" = ${runHolder(runId)}`;
  return renewed > 0;
}

/**
 * Keeps a held lease from expiring. A renewal that finds the row gone or another holder's says
 * so loudly: this holder went quiet for longer than the lease lasts -- its process stalled --
 * and another may now be writing for the same shop.
 */
async function renew(shopId: string, kind: LeaseKind, holder: string): Promise<void> {
  try {
    const renewed = await prisma.$executeRaw`
      UPDATE "shop_leases" SET "expiresAt" = now() + ${SHOP_LEASE_TTL_MS} * interval '1 millisecond'
       WHERE "shopId" = ${shopId} AND "kind" = ${kind} AND "holder" = ${holder}`;
    if (renewed === 0) logger.error("a shop lease was lost while its holder still worked", { shopId, kind, holder });
  } catch (error) {
    logger.warn("a shop lease was not renewed this time", { shopId, kind, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Runs `work` holding the shop's lease, or answers `busy` without running it. Released however
 * `work` ends -- unless what it returns names a holder to keep it (`keepFor`): a chunked run's
 * first turn, which hands the shop to the run for its later turns (#809, D34).
 */
export async function withShopLease<T>(
  shopId: string,
  kind: LeaseKind,
  work: () => Promise<T>,
  { keepFor, ...options }: { holder?: string; campaignId?: string | null; keepFor?: (value: T) => string | null } = {},
): Promise<{ busy: true } | { busy: false; value: T }> {
  const lease = await takeShopLease(shopId, kind, options);
  if (!lease) return { busy: true };
  let value: T;
  try {
    value = await work();
  } catch (error) {
    await lease.release();
    throw error;
  }
  const keeper = keepFor?.(value) ?? null;
  if (keeper) await lease.handOver(keeper);
  else await lease.release();
  return { busy: false, value };
}

/**
 * Who holds the shop's run lease now, when somebody does: the campaign whose run it is, so a
 * run waiting behind it can say which. Null when it is free or expired.
 */
export async function runLeaseHolder(shopId: string): Promise<{ campaignId: string | null } | null> {
  const held = await prisma.shopLease.findFirst({
    where: { shopId, kind: "run", expiresAt: { gt: new Date() } },
    select: { campaignId: true },
  });
  return held ?? null;
}
