/**
 * The pool size is a number this app chose, and says so in the connection string.
 *
 * Prisma's default is `num_physical_cpus * 2 + 1`, read from whichever container the
 * process lands on — so the web service and the worker would each pick their own, and
 * nothing would account for their sum against `max_connections`. Exhaustion then surfaces
 * wherever the next query happened to be, including part way through writing prices.
 *
 * What is worth pinning here is the *precedence*, because every failure mode of this
 * helper is silent: an override that gets replaced makes the Railway dashboard lie about
 * what the process is doing, and a malformed value that throws turns a typo in a tuning
 * knob into a service that will not boot.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_POOL_SIZE, poolUrl } from "./pool";

const BASE = "postgresql://anchor:anchor@localhost:5432/anchor_dev";

const limitOf = (url: string | undefined): string | null =>
  url ? new URL(url).searchParams.get("connection_limit") : null;

describe("choosing the pool size", () => {
  it("applies the default when nothing asks for anything", () => {
    expect(limitOf(poolUrl(BASE))).toBe(String(DEFAULT_POOL_SIZE));
  });

  it("takes an override from the environment", () => {
    expect(limitOf(poolUrl(BASE, "5"))).toBe("5");
  });

  it("leaves a limit already in the URL alone", () => {
    // Whoever set `connection_limit` on the Railway variable meant it. A default quietly
    // replacing it would make the dashboard describe a process that is not running.
    const explicit = `${BASE}?connection_limit=3`;

    expect(limitOf(poolUrl(explicit, "5"))).toBe("3");
  });

  it.each(["", "  ", "many", "0", "-1", "2.5", "NaN"])(
    "falls back to the default for %o rather than refusing to boot",
    (override) => {
      expect(limitOf(poolUrl(BASE, override))).toBe(String(DEFAULT_POOL_SIZE));
    },
  );
});

describe("what it does not damage", () => {
  it("keeps the parameters already on the connection string", () => {
    // Railway's URL carries sslmode. Rebuilding the string without it would silently
    // change how the process connects.
    const withSsl = `${BASE}?sslmode=require&schema=public`;
    const result = new URL(poolUrl(withSsl) ?? "");

    expect(result.searchParams.get("sslmode")).toBe("require");
    expect(result.searchParams.get("schema")).toBe("public");
    expect(result.searchParams.get("connection_limit")).toBe(String(DEFAULT_POOL_SIZE));
  });

  it("keeps credentials, host, port and database", () => {
    const result = new URL(poolUrl(BASE) ?? "");

    expect(result.username).toBe("anchor");
    expect(result.hostname).toBe("localhost");
    expect(result.port).toBe("5432");
    expect(result.pathname).toBe("/anchor_dev");
  });

  it("hands back an unparseable string untouched", () => {
    // Deciding a connection string is invalid is Prisma's job, and its message names the
    // problem. Throwing here would replace that with a stack trace from a tuning helper.
    expect(poolUrl("not a url")).toBe("not a url");
  });

  it("hands back a missing string as missing", () => {
    // So the caller can fall through to `new PrismaClient()` and let Prisma raise the
    // "DATABASE_URL is not set" error it already has good wording for.
    expect(poolUrl(undefined)).toBeUndefined();
  });
});
