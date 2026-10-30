/**
 * The worker gets the worker's pool, and nothing else does (#810).
 *
 * The failure worth a test is the quiet one: the worker built with the web's settings, so a
 * run's writes inherit a page's statement timeout and are cancelled part-way under load.
 * That happens if anything imports the database client before the worker has declared
 * itself, and the client is built at import -- so the order of the worker's imports is
 * load-bearing, and pinned here as well as checked at the worker's boot.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { sourceOf } from "../testing/source";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("which pool a process gets", () => {
  it("is the web's when nothing says otherwise", async () => {
    vi.resetModules();
    const { processRole } = await import("./process-role");

    expect(processRole()).toBe("web");
  });

  it("is the worker's once the worker's entry module has run, before the client is built", async () => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgresql://anchor:anchor@localhost:5432/anchor_role_test");
    vi.stubEnv("DATABASE_STATEMENT_TIMEOUT_WEB_MS", "5000");

    await import("../../worker/as-worker");
    const { databasePool } = await import("../../db.server");

    expect(databasePool.role).toBe("worker");
    expect(databasePool.statementTimeoutMs, "a page's statement timeout reached the worker").toBeUndefined();
  });

  it("gives the web its statement timeout", async () => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgresql://anchor:anchor@localhost:5432/anchor_role_test");
    vi.stubEnv("DATABASE_STATEMENT_TIMEOUT_WEB_MS", "5000");

    const { databasePool } = await import("../../db.server");

    expect(databasePool).toMatchObject({ role: "web", statementTimeoutMs: 5000 });
  });
});

describe("the worker's entry point", () => {
  const worker = sourceOf("scripts/worker.ts");
  const imports = [...worker.matchAll(/^import\s+(?:[^"';]+\s+from\s+)?"([^"]+)";?$/gm)].map(([, from]) => from);

  it("found its imports, so the check below is not vacuous", () => {
    expect(imports.length).toBeGreaterThan(5);
    expect(imports).toContain("../app/db.server");
  });

  it("declares itself the worker before anything else is imported", () => {
    // ES modules evaluate imports in order, depth first, before the file's own body. Any
    // import above this one that reaches `db.server` builds the client with the web's pool.
    expect(imports[0], "`../app/worker/as-worker` must be the worker's first import").toBe("../app/worker/as-worker");
  });

  it("refuses to start on a client built for the web", () => {
    expect(worker).toMatch(/if \(databasePool\.role !== "worker"\)[\s\S]{0,400}process\.exit\(1\)/);
  });

  it("declares the role from a module that cannot reach the database client", () => {
    // If `as-worker` imported anything that imports `db.server`, the client would be built
    // while `as-worker` was still loading its own imports -- before the declaration runs.
    const declaring = sourceOf("app/worker/as-worker.ts");
    const role = sourceOf("app/lib/db/process-role.ts");

    expect([...declaring.matchAll(/from "([^"]+)"/g)].map(([, from]) => from)).toEqual(["../lib/db/process-role"]);
    expect([...role.matchAll(/^import (?!type )/gm)], "process-role may only import types").toEqual([]);
  });
});
