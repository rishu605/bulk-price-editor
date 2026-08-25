/**
 * The check that keeps "the mirror is a cache, Shopify is truth" honest.
 *
 * Without it, mirror drift is invisible until a campaign prices the wrong products — and
 * "the app changed prices it should not have" is not a thing you explain your way out
 * of. So the interesting cases are the ones where a lazy implementation would report a
 * healthy mirror: a tiny shop, a variant Shopify has forgotten, a price hidden behind a
 * compare-at difference on the same row.
 */

import { describe, expect, it } from "vitest";

import { auditSample, sampleSize, MIN_SAMPLE } from "./sampling";

const mirror = (gid: string, price: number | null, compareAt: number | null = null) => ({
  variantGid: gid,
  price: price === null ? null : BigInt(price),
  compareAt: compareAt === null ? null : BigInt(compareAt),
});

describe("sampleSize", () => {
  it("takes half a percent of a large catalogue", () => {
    expect(sampleSize(500_000)).toBe(2_500);
    expect(sampleSize(200_000)).toBe(1_000);
  });

  it("never drops below the floor on a small shop", () => {
    // Half a percent of two hundred variants is one, which cannot tell a healthy
    // mirror from a broken one: one mismatch reads as 100% divergence.
    expect(sampleSize(200)).toBe(200);
    expect(sampleSize(50_000)).toBe(MIN_SAMPLE);
  });

  it("never asks for more variants than exist", () => {
    expect(sampleSize(10)).toBe(10);
    expect(sampleSize(0)).toBe(0);
  });
});

describe("auditSample", () => {
  it("reports a clean mirror as clean", () => {
    const verdict = auditSample([mirror("v1", 1_000)], [mirror("v1", 1_000)]);
    expect(verdict.diverged).toBe(0);
    expect(verdict.rate).toBe(0);
    expect(verdict.alert).toBe(false);
  });

  it("catches a price that has moved underneath the mirror", () => {
    const verdict = auditSample([mirror("v1", 1_000)], [mirror("v1", 900)]);
    expect(verdict.divergences[0]).toMatchObject({ kind: "price", mirror: 1_000n, live: 900n });
  });

  it("counts a variant Shopify no longer knows about", () => {
    // A mirror full of products that no longer exist will enroll them in a campaign,
    // where every row then fails — and a run reporting four hundred failures nobody
    // can act on is a run nobody reads.
    const verdict = auditSample([mirror("v1", 1_000)], []);
    expect(verdict.divergences[0].kind).toBe("unknown-to-shopify");
    expect(verdict.diverged).toBe(1);
  });

  it("does not let a compare-at difference hide a price one on the same row", () => {
    const verdict = auditSample([mirror("v1", 1_000, 2_000)], [mirror("v1", 900, 3_000)]);
    expect(verdict.divergences).toHaveLength(1);
    expect(verdict.divergences[0].kind).toBe("price");
  });

  it("still reports a compare-at difference when the price agrees", () => {
    const verdict = auditSample([mirror("v1", 1_000, 2_000)], [mirror("v1", 1_000, 3_000)]);
    expect(verdict.divergences[0].kind).toBe("compare-at");
  });

  it("alerts above the threshold and not at it", () => {
    // A threshold that fires at exactly the line means every shop sitting on it alerts
    // every night, and the alert stops meaning anything.
    const rows = Array.from({ length: 200 }, (_, i) => mirror(`v${i}`, 1_000));
    const oneOff = rows.map((r, i) => (i === 0 ? mirror("v0", 999) : r));

    const exactly = auditSample(rows, oneOff, 0.005);
    expect(exactly.rate).toBe(0.005);
    expect(exactly.alert).toBe(false);

    const over = auditSample(rows, rows.map((r, i) => (i < 2 ? mirror(`v${i}`, 999) : r)), 0.005);
    expect(over.alert).toBe(true);
  });

  it("never alerts on an empty sample", () => {
    // A shop with nothing mirrored has not diverged, it has not started.
    const verdict = auditSample([], []);
    expect(verdict.rate).toBe(0);
    expect(verdict.alert).toBe(false);
  });

  it("treats a null price and a zero price as different", () => {
    // "We do not know this variant's price" and "this variant costs nothing" are not
    // the same fact, and conflating them hides a real divergence.
    expect(auditSample([mirror("v1", null)], [mirror("v1", 0)]).diverged).toBe(1);
  });
});
