import { defineConfig } from "vitest/config";

/**
 * The chaos suite runs separately from `npm test` on purpose.
 *
 * The unit suite is pure and takes seconds; developers run it constantly. These
 * scenarios need a real Postgres, spawn processes and sleep on real timers. Mixing
 * them would make the fast suite slow and the slow suite's failures easy to ignore.
 *
 * `retry: 0` is not an oversight. A chaos suite that retries launders a real
 * intermittent bug into a green tick, which is precisely the reporting dishonesty the
 * suite exists to catch the engine doing.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["chaos/scenarios/**/*.chaos.ts"],
    setupFiles: ["chaos/harness/setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    retry: 0,
    // One at a time: scenarios share a Postgres and each spawns processes, and a
    // failure whose cause might be another scenario's load is not a useful failure.
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["verbose"],
  },
});
