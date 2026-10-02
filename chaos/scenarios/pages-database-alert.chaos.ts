/**
 * The alerting job hears when the pages are waiting for the database (#803).
 *
 * One shop's 102,132-variant apply ran the web process's connection pool dry: every shop's
 * pages went blank for minutes, the run died of a pool timeout part-way (#802), and
 * `/healthz` said "ok" throughout. The alerting job runs in the worker, whose pool is its
 * own -- its queries were instant while the pages starved -- so it reads the web process's
 * `/healthz` over HTTP, which now says how long its trivial query waited.
 *
 * A stand-in web process answers `/healthz` here, saying what the real one says.
 */

import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluate } from "../../app/lib/observability/alerts";
import { gather } from "../../app/services/alerting.server";

let server: Server | null = null;

async function webSaying(body: unknown): Promise<string> {
  server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const fired = async () => evaluate(await gather()).map((alert) => alert.id);

describe("chaos: the pages wait for the database", () => {
  it("pages when the web process's health check waited seconds for a connection", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", await webSaying({ status: "degraded", database: { ok: true, waitMs: 6_800 } }));

    const window = await gather();
    expect(window.pagesDatabaseWaitMs).toBe(6_800);
    expect(await fired(), "a starved pool raised nothing").toContain("pages-waiting-for-database");
  });

  it("stays quiet for an ordinary answer", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", await webSaying({ status: "ok", database: { ok: true, waitMs: 3 } }));
    expect(await fired()).not.toContain("pages-waiting-for-database");
  });

  it("says nothing it does not know: no app URL, or a web process that cannot be reached", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "");
    expect((await gather()).pagesDatabaseWaitMs).toBeNull();

    // Nothing listening: the deploy's own health check is for that, not this signal.
    vi.stubEnv("SHOPIFY_APP_URL", "http://127.0.0.1:9");
    expect((await gather()).pagesDatabaseWaitMs).toBeNull();
  });
});
