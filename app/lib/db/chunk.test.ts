/**
 * Splitting `IN` lists.
 *
 * The bug this exists for was not "no chunking" — Prisma chunks long `IN` lists by
 * itself. It was that Prisma chunks at exactly the ceiling and then adds the query's
 * other bind variables on top, so a campaign of 62,535 variants died on `received
 * 32769` before a single price was written.
 *
 * So the properties worth pinning are the ones that make that impossible to
 * reintroduce: every element is covered exactly once and in order, and a full batch
 * plus a generous number of other binds still sits under the ceiling.
 */

import { describe, expect, it } from "vitest";

import { BIND_VARIABLE_CEILING, IN_CHUNK, chunk, inChunks, inChunksCounting } from "./chunk";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `gid://v/${i}`);

describe("chunk", () => {
  it("leaves room for the rest of the where clause", () => {
    expect(
      IN_CHUNK,
      "a full batch plus other filters must not approach the ceiling",
    ).toBeLessThan(BIND_VARIABLE_CEILING / 2);
  });

  it("returns nothing for an empty list, so callers do not query for nothing", () => {
    expect(chunk([])).toEqual([]);
  });

  it("keeps a short list in one batch", () => {
    expect(chunk(ids(3), 5)).toEqual([ids(3)]);
  });

  it("splits exactly at the boundary rather than one either side", () => {
    expect(chunk(ids(10), 5)).toHaveLength(2);
    expect(chunk(ids(11), 5)).toHaveLength(3);
    expect(chunk(ids(9), 5).map((b) => b.length)).toEqual([5, 4]);
  });

  it("covers every element exactly once, in order", () => {
    const source = ids(23);
    expect(chunk(source, 5).flat()).toEqual(source);
  });

  it("refuses a size that would loop forever", () => {
    expect(() => chunk(ids(3), 0)).toThrow(/at least 1/);
  });
});

describe("inChunks", () => {
  it("never sends a batch bigger than the size", async () => {
    const sizes: number[] = [];
    await inChunks(ids(62_535), async (batch) => {
      sizes.push(batch.length);
      return batch;
    });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(IN_CHUNK);
  });

  it("returns every row, in batch order", async () => {
    const source = ids(12);
    const rows = await inChunks(source, async (batch) => batch.map((id) => id.toUpperCase()), 5);
    expect(rows).toEqual(source.map((id) => id.toUpperCase()));
  });

  it("does not query at all for an empty list", async () => {
    let calls = 0;
    const rows = await inChunks([], async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(0);
    expect(rows).toEqual([]);
  });

  it("keeps a single batch to one round trip", async () => {
    let calls = 0;
    await inChunks(ids(IN_CHUNK), async (batch) => {
      calls++;
      return batch;
    });
    expect(calls, "a list that fits must not pay for batching").toBe(1);
  });
});

describe("inChunksCounting", () => {
  it("sums the counts rather than reporting the last batch's", async () => {
    const result = await inChunksCounting(ids(12), async (batch) => ({ count: batch.length }), 5);
    expect(result.count, "an updateMany across batches must report the total").toBe(12);
  });

  it("counts zero for an empty list without calling the mutation", async () => {
    let calls = 0;
    const result = await inChunksCounting([], async () => {
      calls++;
      return { count: 1 };
    });
    expect(calls).toBe(0);
    expect(result.count).toBe(0);
  });
});
