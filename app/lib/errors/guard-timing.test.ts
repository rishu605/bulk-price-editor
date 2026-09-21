/**
 * Whether the server can say how long it took.
 *
 * #616 reported Home as blank for twelve seconds and there was no way to attribute it:
 * the loader, the embedded-app boot and the host were all candidates and none of them
 * was instrumented. Measured by hand on a local machine the loader was 16–30ms end to
 * end, auth included — so the blank period was not ours — but that is a number nobody
 * else can reproduce, and the question recurs every time a page feels slow.
 *
 * Every route is already wrapped in `withGuard`, which makes it the one place that can
 * answer this for all of them at once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { withGuard } from "./guard.server";
import * as telemetry from "../telemetry/metrics";

const recorded = () =>
  (telemetry.metric as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
    (call) => call[0] === "route.server_ms",
  );

afterEach(() => vi.restoreAllMocks());

describe("a route that succeeds", () => {
  it("records how long it took, against its own name", async () => {
    vi.spyOn(telemetry, "metric").mockImplementation(() => {});

    const loader = withGuard("/app", async () => ({ ok: true }));
    await loader({ request: new Request("https://example.com/app") } as never);

    const [, value, labels] = recorded()[0] as [string, number, Record<string, unknown>];

    expect(typeof value).toBe("number");
    expect(labels.route).toBe("/app");
    expect(labels.outcome).toBe("ok");
  });

  it("still returns exactly what the handler returned", async () => {
    vi.spyOn(telemetry, "metric").mockImplementation(() => {});

    const loader = withGuard("/app", async () => ({ shop: "boltify" }));

    expect(await loader({ request: new Request("https://example.com/app") } as never)).toEqual({
      shop: "boltify",
    });
  });
});

describe("a route that redirects", () => {
  it("is timed too, because a re-auth bounce is the slowest thing a route does", async () => {
    // `authenticate.admin` signals "sign in again" by throwing a Response. Timing only
    // the successes would hide exactly the case #616 was about.
    vi.spyOn(telemetry, "metric").mockImplementation(() => {});

    const loader = withGuard("/app", async () => {
      throw new Response(null, { status: 302, headers: { location: "/auth" } });
    });

    await expect(
      loader({ request: new Request("https://example.com/app") } as never),
    ).rejects.toBeInstanceOf(Response);

    expect((recorded()[0] as [string, number, Record<string, unknown>])[2].outcome).toBe(
      "redirect",
    );
  });

  it("lets the Response through unchanged", async () => {
    vi.spyOn(telemetry, "metric").mockImplementation(() => {});
    const bounce = new Response(null, { status: 302 });

    const loader = withGuard("/app", async () => {
      throw bounce;
    });

    await expect(
      loader({ request: new Request("https://example.com/app") } as never),
    ).rejects.toBe(bounce);
  });
});

describe("what the measurement carries", () => {
  it("is a duration and a route, never anything about the page", async () => {
    // `CLAUDE.md`: telemetry never carries price values — shop id, plan, counts and
    // durations only.
    vi.spyOn(telemetry, "metric").mockImplementation(() => {});

    const loader = withGuard("/app/campaigns/$id", async () => ({ price: 1999 }));
    await loader({ request: new Request("https://example.com/app") } as never);

    const [, , labels] = recorded()[0] as [string, number, Record<string, unknown>];

    expect(Object.keys(labels).sort()).toEqual(["method", "outcome", "route"]);
  });
});
