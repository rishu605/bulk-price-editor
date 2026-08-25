/**
 * Loads the environment the chaos suite needs, and refuses to run without it.
 *
 * Failing loudly here rather than letting Prisma fail per-scenario matters: a chaos
 * suite that errors for a mundane configuration reason looks identical to one that
 * caught a real bug, and the second time that happens people stop reading the output.
 */

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env is fine as long as the variable is set some other way, as in CI.
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "The chaos suite needs a real Postgres. Set DATABASE_URL (or put it in .env) " +
      "and run `docker compose up -d` first.",
  );
}
