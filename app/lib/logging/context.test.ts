/**
 * Ambient log context.
 *
 * The properties worth protecting are the ones that fail silently. A context that
 * replaced instead of merging, or that let an absent optional id erase a bound one,
 * still produces log lines — just log lines missing the id somebody will filter on
 * during an incident, which is the moment nobody is in a position to notice.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { addLogContext, currentLogContext, withLogContext } from "./context.server";
import { installLogContext, logger, resetLogContextForTests } from "./logger";

/** Captures one JSON log line. Production format, which is the one that gets queried. */
async function lineFrom(work: () => Promise<void>): Promise<Record<string, unknown>> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("NODE_ENV", "production");
  try {
    await work();
    const last = spy.mock.calls.at(-1)?.[0];
    return JSON.parse(String(last)) as Record<string, unknown>;
  } finally {
    vi.unstubAllEnvs();
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("binding", () => {
  it("puts the bound ids on a line that passed none of them", async () => {
    const line = await lineFrom(() =>
      withLogContext({ shopId: "shop_1", runId: "run_1", jobId: "job_1" }, async () => {
        logger.info("planned");
      }),
    );

    expect(line).toMatchObject({
      message: "planned",
      shopId: "shop_1",
      runId: "run_1",
      jobId: "job_1",
    });
  });

  it("adds nothing when no context is bound", async () => {
    const line = await lineFrom(async () => {
      logger.info("planned");
    });

    expect(line.shopId).toBeUndefined();
    expect(line.jobId).toBeUndefined();
  });

  it("does not leak out of the scope that bound it", async () => {
    await withLogContext({ shopId: "shop_1" }, async () => {});
    expect(currentLogContext()).toEqual({});
  });

  it("keeps concurrent scopes apart", async () => {
    const seen: Array<string | undefined> = [];

    const one = withLogContext({ jobId: "job_1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentLogContext().jobId);
    });
    const two = withLogContext({ jobId: "job_2" }, async () => {
      seen.push(currentLogContext().jobId);
    });

    await Promise.all([one, two]);
    expect(seen.sort()).toEqual(["job_1", "job_2"]);
  });
});

describe("nesting", () => {
  /**
   * The property the whole design rests on. A run binds inside a job, and the run knows
   * nothing about how it was reached — so replacing rather than merging would drop the
   * job id on exactly the lines a failed job is investigated through.
   */
  it("merges with the enclosing scope rather than replacing it", async () => {
    const line = await lineFrom(() =>
      withLogContext({ shopId: "shop_1", jobId: "job_1" }, () =>
        withLogContext({ campaignId: "camp_1", runId: "run_1" }, async () => {
          logger.info("executing");
        }),
      ),
    );

    expect(line).toMatchObject({
      shopId: "shop_1",
      jobId: "job_1",
      campaignId: "camp_1",
      runId: "run_1",
    });
  });

  it("lets an inner scope override an id the outer one bound", async () => {
    const line = await lineFrom(() =>
      withLogContext({ runId: "run_outer" }, () =>
        withLogContext({ runId: "run_inner" }, async () => {
          logger.info("executing");
        }),
      ),
    );

    expect(line.runId).toBe("run_inner");
  });

  /**
   * `traced()` passes `runId: ref.runId` for every job class, and most job classes carry
   * no run. Spreading that `undefined` over a bound id would erase it.
   */
  it("does not let an absent optional id erase one already bound", async () => {
    const line = await lineFrom(() =>
      withLogContext({ shopId: "shop_1", runId: "run_1" }, () =>
        withLogContext({ runId: undefined, campaignId: "camp_1" }, async () => {
          logger.info("executing");
        }),
      ),
    );

    expect(line.runId).toBe("run_1");
    expect(line.campaignId).toBe("camp_1");
  });

  it("restores the outer scope when the inner one ends", async () => {
    await withLogContext({ jobId: "job_1" }, async () => {
      await withLogContext({ jobId: "job_2" }, async () => {});
      expect(currentLogContext().jobId).toBe("job_1");
    });
  });
});

describe("addLogContext", () => {
  /** The run id does not exist until the `campaign_runs` row does. */
  it("reaches lines logged after it, in the scope already running", async () => {
    const line = await lineFrom(() =>
      withLogContext({ shopId: "shop_1" }, async () => {
        addLogContext({ runId: "run_1" });
        logger.info("executing");
      }),
    );

    expect(line).toMatchObject({ shopId: "shop_1", runId: "run_1" });
  });

  it("does not reach lines logged before it", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    });
    vi.stubEnv("NODE_ENV", "production");

    await withLogContext({ shopId: "shop_1" }, async () => {
      logger.info("planning");
      addLogContext({ runId: "run_1" });
      logger.info("executing");
    });

    vi.unstubAllEnvs();
    spy.mockRestore();

    expect(lines[0].runId).toBeUndefined();
    expect(lines[1].runId).toBe("run_1");
  });

  it("does not escape into a sibling scope", async () => {
    await withLogContext({ shopId: "shop_1" }, async () => {
      addLogContext({ runId: "run_1" });
    });

    await withLogContext({ shopId: "shop_2" }, async () => {
      expect(currentLogContext().runId).toBeUndefined();
    });
  });

  it("is a no-op outside any scope rather than throwing", () => {
    expect(() => addLogContext({ runId: "run_1" })).not.toThrow();
    expect(currentLogContext()).toEqual({});
  });
});

describe("the logger's side of the seam", () => {
  /**
   * An id bound at a boundary is no more trustworthy than a field passed at a call site.
   * Redaction runs over the merged object, not around the ambient half of it.
   */
  it("redacts ambient fields, not only the ones passed at the call site", async () => {
    const line = await lineFrom(() =>
      // `shop` is a domain in real use; the point is that whatever is bound goes through
      // the same passes. A money-shaped value must not survive because it arrived here.
      withLogContext({ shop: "19.99" } as never, async () => {
        logger.info("executing");
      }),
    );

    expect(line.shop).toBe("[redacted:price]");
  });

  it("lets an explicit field at the call site win over the bound one", async () => {
    const line = await lineFrom(() =>
      withLogContext({ runId: "run_ambient" }, async () => {
        logger.info("verifying a different run", { runId: "run_explicit" });
      }),
    );

    expect(line.runId).toBe("run_explicit");
  });

  it("still logs when reading the context throws", async () => {
    try {
      installLogContext(() => {
        throw new Error("async context is broken");
      });

      const line = await lineFrom(async () => {
        logger.info("executing");
      });

      expect(line.message).toBe("executing");
      expect(line.shopId).toBeUndefined();
    } finally {
      // Re-register by hand. `context.server.ts` installs itself at import and ESM
      // caches the module, so re-importing it would not run that line again and every
      // later test in this worker would see an empty context.
      installLogContext(currentLogContext);
    }
  });

  it("behaves as it did before when nothing is registered", async () => {
    try {
      resetLogContextForTests();

      const line = await lineFrom(() =>
        withLogContext({ shopId: "shop_1" }, async () => {
          logger.info("executing", { route: "/app/campaigns" });
        }),
      );

      expect(line).toMatchObject({ message: "executing", route: "/app/campaigns" });
      expect(line.shopId).toBeUndefined();
    } finally {
      installLogContext(currentLogContext);
    }
  });
});
