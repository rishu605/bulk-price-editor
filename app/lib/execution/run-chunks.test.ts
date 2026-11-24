/**
 * Which runs are written in chunks, how large a chunk is, and how a turn writes a row again from
 * its ledger exactly as the plan wrote it (#809, D34).
 */

import { describe, expect, it } from "vitest";

import { CLAMP_REASONS } from "../campaigns/clamp-reasons";
import { money } from "../money/money";
import { DEFAULT_THRESHOLD } from "../planning/write-path";
import { SMALL_RUN_MS } from "./run-lane";
import { CARRY_FAILURES, chunkRowsFor, MAX_TURN_RESTARTS, plannedRowOf, RUN_CHUNK_ROWS, type PendingLedgerRow } from "./run-chunks";

/** Shopify's share of a bulk operation, per variant: inline-budget's anchor-perf figure. */
const BULK_MS_PER_VARIANT = 1.75;

describe("which runs are written in chunks", () => {
  it("chunks a bulk-path run larger than one chunk, and nothing else", () => {
    expect(chunkRowsFor(RUN_CHUNK_ROWS + 1, "bulk")).toBe(RUN_CHUNK_ROWS);
    expect(chunkRowsFor(102_132, "bulk")).toBe(RUN_CHUNK_ROWS);
    // One chunk's worth gains nothing from waiting for a second turn to write it.
    expect(chunkRowsFor(RUN_CHUNK_ROWS, "bulk")).toBeNull();
    // A sync-path run is at most the bulk threshold, minutes by the inline budget's figures.
    expect(chunkRowsFor(RUN_CHUNK_ROWS + 1, "sync")).toBeNull();
    expect(chunkRowsFor(0, "bulk")).toBeNull();
  });

  it("takes the size it is given, so a scenario can chunk a run it can seed", () => {
    expect(chunkRowsFor(1_500, "bulk", 500)).toBe(500);
    expect(chunkRowsFor(1_500, "bulk", 0)).toBeNull();
  });

  it("sizes a chunk from the bulk path's own numbers", () => {
    // Bulk-sized: well past the crossover where one operation beats a call a product, or the
    // operation's own costs are the run.
    expect(RUN_CHUNK_ROWS).toBeGreaterThanOrEqual(5 * DEFAULT_THRESHOLD);
    // And Shopify's share of a chunk is a fraction of what the small lane calls short, so a turn
    // holds a large-lane slot for well under the wait the small lane exists to bound.
    expect(RUN_CHUNK_ROWS * BULK_MS_PER_VARIANT).toBeLessThan(SMALL_RUN_MS / 10);
    // A 100k run is tens of turns, not a hundred operations.
    expect(Math.ceil(102_132 / RUN_CHUNK_ROWS)).toBeLessThanOrEqual(25);
  });

  it("gives a dead turn back a few times, never for ever", () => {
    expect(MAX_TURN_RESTARTS).toBeGreaterThan(0);
    expect(MAX_TURN_RESTARTS).toBeLessThanOrEqual(5);
    // The run's messages show five at most.
    expect(CARRY_FAILURES).toBe(5);
  });
});

describe("a turn writes a row as the plan wrote it", () => {
  const row = (over: Partial<PendingLedgerRow> = {}): PendingLedgerRow => ({
    variantGid: "gid://shopify/ProductVariant/1",
    currency: "USD",
    beforePrice: 4_000n,
    beforeCompareAt: null,
    intendedPrice: 3_600n,
    intendedCompareAt: null,
    intendedCompareAtSet: false,
    failureReason: null,
    ...over,
  });

  it("carries the price, the before price and the base surface", () => {
    expect(plannedRowOf(row())).toEqual({
      ref: { variantGid: "gid://shopify/ProductVariant/1", surfaceKind: "base", priceListGid: "", currency: "USD" },
      beforePrice: money(4_000, "USD"),
      beforeCompareAt: undefined,
      intendedPrice: money(3_600, "USD"),
      intendedCompareAt: undefined,
      intendedCompareAtSet: false,
      status: "pending",
    });
  });

  it("tells a compare-at the plan clears from one it leaves alone", () => {
    // Conflating them wipes a merchant's compare-at, or fails to set up a strike-through.
    expect(plannedRowOf(row({ intendedCompareAtSet: true })).intendedCompareAt).toBeNull();
    expect(plannedRowOf(row({ intendedCompareAtSet: false })).intendedCompareAt).toBeUndefined();
    expect(plannedRowOf(row({ intendedCompareAt: 4_000n, intendedCompareAtSet: true })).intendedCompareAt).toEqual(money(4_000, "USD"));
  });

  it("keeps a clamped row clamped, for the reason the ledger says, so it is recorded CLAMPED (#792)", () => {
    for (const [reason, text] of CLAMP_REASONS) {
      expect(plannedRowOf(row({ failureReason: text }))).toMatchObject({ status: "clamped", reason });
    }
  });

  it("writes JPY in its own minor units", () => {
    expect(plannedRowOf(row({ currency: "JPY", intendedPrice: 1_200n })).intendedPrice).toEqual(money(1_200, "JPY"));
  });
});
