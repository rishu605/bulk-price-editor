/**
 * Which of one product's waiting deliveries the worker handles (#811): the newest by
 * Shopify's stamp, never an older one over it, and never a version it cannot order.
 */

import { describe, expect, it } from "vitest";

import { coalesceDeliveries, type WaitingDelivery } from "./webhook-coalesce";

let arrival = 0;
function delivery(id: string, updatedAt: string | null, topic = "products/update"): WaitingDelivery {
  return {
    id,
    topic,
    payload: updatedAt === null ? { id: 1 } : { id: 1, updated_at: updatedAt },
    receivedAt: new Date(Date.UTC(2026, 9, 29, 12, 0, 0, ++arrival)),
  };
}
const ids = (list: WaitingDelivery[]) => list.map((d) => d.id);

describe("coalescing one product's waiting deliveries", () => {
  it("handles the newest of ten, by Shopify's stamp rather than by arrival", () => {
    // Arrival order shuffled: the last to arrive is not the newest.
    const order = [3, 9, 0, 5, 1, 8, 2, 7, 4, 6];
    const waiting = order.map((minute) => delivery(`m${minute}`, `2026-10-29T12:0${minute}:00Z`));
    const { handle, superseded } = coalesceDeliveries(waiting);
    expect(ids(handle)).toEqual(["m9"]);
    expect(ids(superseded).sort()).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  });

  it("handles every delivery at the newest stamp, in arrival order, since a second cannot order them", () => {
    const waiting = [delivery("old", "2026-10-29T12:00:00Z"), delivery("a", "2026-10-29T12:01:00Z"), delivery("b", "2026-10-29T12:01:00Z")];
    const { handle, superseded } = coalesceDeliveries(waiting);
    expect(ids(handle)).toEqual(["a", "b"]);
    expect(ids(superseded)).toEqual(["old"]);
  });

  it("never lets go of a delivery without a stamp, and handles it before the dated ones", () => {
    const waiting = [delivery("dated", "2026-10-29T12:01:00Z"), delivery("undated", null)];
    const { handle, superseded } = coalesceDeliveries(waiting);
    expect(ids(handle)).toEqual(["undated", "dated"]);
    expect(superseded).toEqual([]);
  });

  it("handles a deletion alone: an update for a deleted product describes it as it was", () => {
    const waiting = [delivery("before", "2026-10-29T12:00:00Z"), delivery("gone", null, "products/delete"), delivery("late", "2026-10-29T11:59:00Z")];
    const { handle, superseded } = coalesceDeliveries(waiting);
    expect(ids(handle)).toEqual(["gone"]);
    expect(ids(superseded)).toEqual(["before", "late"]);
  });

  it("reads the topic however it is spelled", () => {
    const { handle } = coalesceDeliveries([delivery("u", "2026-10-29T12:00:00Z"), delivery("d", null, "PRODUCTS_DELETE")]);
    expect(ids(handle)).toEqual(["d"]);
  });

  it("handles a lone delivery as it is", () => {
    const only = delivery("only", "2026-10-29T12:00:00Z");
    expect(coalesceDeliveries([only])).toEqual({ handle: [only], superseded: [] });
  });
});
