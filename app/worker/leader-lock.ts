/**
 * Redis leader election for the scheduler tick.
 *
 * Running several worker replicas is normal. Two of them independently deciding a
 * campaign is due would start the same transition twice, so exactly one may tick at
 * a time.
 *
 * The lock's TTL is deliberately shorter than the interval between renewals plus a
 * margin: a leader that dies mid-tick simply stops renewing, the key expires, and
 * another worker takes over on its next attempt. No cleanup, no heartbeat table, no
 * split brain lasting longer than one TTL.
 */

export interface RedisLike {
  set(
    key: string,
    value: string,
    mode: "PX",
    ttl: number,
    condition: "NX",
  ): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** Releases only if we still hold it, so a slow worker cannot free someone else's lock. */
const RELEASE = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/** Extends only our own hold, for the same reason. */
const RENEW = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

export class LeaderLock {
  private readonly token: string;

  constructor(
    private readonly redis: RedisLike,
    private readonly key = "anchor:scheduler:leader",
    private readonly ttlMs = 30_000,
  ) {
    // Unique per instance so a lock can only ever be released or renewed by the
    // process that took it.
    this.token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async acquire(): Promise<boolean> {
    const result = await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX");
    return result === "OK";
  }

  async renew(): Promise<boolean> {
    const result = await this.redis.eval(RENEW, 1, this.key, this.token, String(this.ttlMs));
    return result === 1;
  }

  async release(): Promise<void> {
    await this.redis.eval(RELEASE, 1, this.key, this.token);
  }
}
