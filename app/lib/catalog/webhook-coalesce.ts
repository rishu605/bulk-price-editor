/**
 * Which of one product's waiting deliveries the worker handles, and which it lets go (#811).
 *
 * A product written in several calls, edited twice in a minute, or caught in a run's echo
 * storm has several `products/*` deliveries waiting at once. Each describes the whole
 * product as it was at its own `updated_at`, so only the newest says anything the others do
 * not -- handling every one of them was the per-delivery work that, multiplied by a 100k
 * run's echoes, held the app at its pool timeout (#803). Drift and enrolment see only what
 * is handled, so they see the latest too, never an older payload after a newer one.
 *
 * Newest is Shopify's stamp, not arrival: deliveries are not ordered, and the last to
 * arrive can be the oldest. Two rules keep this from ever dropping a version:
 *
 *   - Every delivery at the newest stamp is handled, oldest-arriving first. Shopify stamps to
 *     the second, and a product written in several calls in one second sends several
 *     deliveries with one stamp that are not the same snapshot (#985). Which of them is the
 *     latest the stamp cannot say, so each goes through the mirror's own version rule, as
 *     every delivery did before.
 *   - A delivery without a stamp cannot be ordered against the rest, so it is never let go:
 *     it is handled, before the stamped ones, as before.
 *
 * A delete ends the product. Product ids are never reused, so an update for it -- whenever
 * it was sent -- describes it before it was deleted, and the delete alone is handled.
 */

export interface WaitingDelivery {
  id: string;
  /** As the delivery log records it: `products/update`. */
  topic: string;
  payload: unknown;
  receivedAt: Date;
}

export interface Coalesced<T extends WaitingDelivery> {
  /** To handle, in this order. */
  handle: T[];
  /** Described the product at a version something in `handle` is newer than. */
  superseded: T[];
}

export function coalesceDeliveries<T extends WaitingDelivery>(deliveries: readonly T[]): Coalesced<T> {
  const arrived = [...deliveries].sort(
    (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id),
  );

  const deletion = arrived.find((delivery) => isDelete(delivery.topic));
  if (deletion) return { handle: [deletion], superseded: arrived.filter((delivery) => delivery !== deletion) };

  const stamps = new Map(arrived.map((delivery) => [delivery, stampOf(delivery.payload)]));
  const dated = arrived.filter((delivery) => stamps.get(delivery) !== null);
  const newest = Math.max(...dated.map((delivery) => stamps.get(delivery)!));

  const undated = arrived.filter((delivery) => stamps.get(delivery) === null);
  const latest = dated.filter((delivery) => stamps.get(delivery) === newest);
  return {
    handle: [...undated, ...latest],
    superseded: dated.filter((delivery) => stamps.get(delivery)! < newest),
  };
}

function isDelete(topic: string): boolean {
  return topic.toLowerCase().replace("_", "/") === "products/delete";
}

/** The product's `updated_at`, in milliseconds, or null when absent or unreadable. */
function stampOf(payload: unknown): number | null {
  const raw = (payload as { updated_at?: unknown } | null)?.updated_at;
  if (typeof raw !== "string" || !raw) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}
