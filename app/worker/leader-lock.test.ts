import { describe, expect, it } from "vitest";

import { LeaderLock, type RedisLike } from "./leader-lock";

/** In-memory stand-in with the SET NX PX and eval semantics the lock relies on. */
function fakeRedis() {
  const store = new Map<string, string>();
  const redis: RedisLike = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async set(key, value, _mode, _ttl, _condition) {
      if (store.has(key)) return null;      // NX: only if absent
      store.set(key, value);
      return "OK";
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async eval(script, _numKeys, key, token) {
      // Both scripts are guarded on "do we still hold it".
      if (store.get(key) !== token) return 0;
      if (script.includes("del")) store.delete(key);
      return 1;
    },
    async quit() {},
  };
  return { redis, store };
}

describe("leader lock", () => {
  it("lets exactly one of several workers lead", async () => {
    const { redis } = fakeRedis();
    const a = new LeaderLock(redis);
    const b = new LeaderLock(redis);
    const c = new LeaderLock(redis);

    const results = await Promise.all([a.acquire(), b.acquire(), c.acquire()]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("lets the holder renew but not anyone else", async () => {
    const { redis } = fakeRedis();
    const holder = new LeaderLock(redis);
    const other = new LeaderLock(redis);

    expect(await holder.acquire()).toBe(true);
    expect(await holder.renew()).toBe(true);
    expect(await other.renew()).toBe(false);
  });

  it("only releases its own hold, never someone else's", async () => {
    // The reason release is a compare-and-delete script rather than a plain DEL: a
    // slow worker waking up after its lock expired must not free the new leader's.
    const { redis, store } = fakeRedis();
    const holder = new LeaderLock(redis);
    const other = new LeaderLock(redis);

    await holder.acquire();
    await other.release();
    expect(store.size).toBe(1);

    await holder.release();
    expect(store.size).toBe(0);
  });

  it("hands leadership over after a release", async () => {
    const { redis } = fakeRedis();
    const first = new LeaderLock(redis);
    const second = new LeaderLock(redis);

    await first.acquire();
    expect(await second.acquire()).toBe(false);
    await first.release();
    expect(await second.acquire()).toBe(true);
  });
});
