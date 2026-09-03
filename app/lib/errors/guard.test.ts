/**
 * The wrapper around twenty loaders and actions.
 *
 * Everything here is a property the module's own header or a comment beside the code
 * says must hold, and every one of them could be broken with the whole suite green:
 * the Response pass-through, reporting before throwing, the status, the route, and
 * `shopContext` being unable to throw.
 *
 * Two of them are not cosmetic. Swallowing a thrown Response replaces Shopify's silent
 * re-authentication with an error screen. Throwing before `reportError` finishes hands
 * the merchant an id that is not in `error_events` — which the header calls the one
 * answer a diagnostics page must never give, and which is the reason this module exists
 * rather than the boundary doing the work.
 *
 * `reportError` is mocked rather than exercised: it needs Prisma, and what is under test
 * here is the wrapper's contract with it — that it is called, called first, and that its
 * result is what shapes the thrown response.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReportedError } from "./report";

const reportError = vi.fn();

vi.mock("../../services/error-report.server", () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

const { withGuard, ANCHOR_ERROR } = await import("./guard.server");

const reported: ReportedError = {
  errorId: "err_abc123",
  code: "NOT_FOUND",
  userMessage: "That campaign no longer exists.",
  retryable: false,
  status: 404,
};

beforeEach(() => {
  reportError.mockReset();
  reportError.mockResolvedValue(reported);
});

const args = (url = "https://x.test/app/campaigns?shop=demo.myshopify.com") => ({
  request: new Request(url, { method: "POST" }),
});

/** The thrown value from a guarded handler that failed. */
async function thrownBy(handler: () => Promise<unknown>, at = "/app/campaigns") {
  try {
    await withGuard(at, handler)(args());
    throw new Error("the guard did not throw");
  } catch (error) {
    return error as { init?: { status?: number }; data?: Record<string, ReportedError> };
  }
}

describe("the happy path is left alone", () => {
  it("returns what the handler returned", async () => {
    await expect(withGuard("/app", async () => ({ ok: true }))(args())).resolves.toEqual({
      ok: true,
    });
  });

  it("reports nothing when nothing failed", async () => {
    await withGuard("/app", async () => null)(args());

    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("a thrown Response passes straight through", () => {
  /**
   * Not an optimisation. `authenticate.admin` signals "redirect this embedded app to
   * re-authenticate" *by throwing a Response*, so catching it turns a silent sign-in
   * into an error screen — and the merchant is then stuck, because the thing that would
   * have signed them in is the thing being swallowed.
   */
  it("rethrows the redirect rather than reporting it", async () => {
    const redirect = new Response(null, { status: 302, headers: { location: "/auth" } });

    const thrown = await thrownBy(async () => {
      throw redirect;
    });

    expect(thrown, "the auth redirect was replaced by an error screen").toBe(redirect);
    expect(reportError, "an auth redirect was recorded as a failure").not.toHaveBeenCalled();
  });

  it("passes a non-redirect Response through too", async () => {
    const notFound = new Response("nope", { status: 404 });

    expect(await thrownBy(async () => {
      throw notFound;
    })).toBe(notFound);
  });
});

describe("a real failure is recorded before it is thrown", () => {
  /**
   * The reason this module exists. An id minted without a row behind it means a merchant
   * quoting it gets "no error stored under that reference".
   */
  it("awaits reportError, so the row exists before the id is shown", async () => {
    let settled = false;
    reportError.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = true;
      return reported;
    });

    await thrownBy(async () => {
      throw new Error("boom");
    });

    expect(settled, "the id reached the merchant before the row was written").toBe(true);
  });

  it("throws the id and message the report produced", async () => {
    const thrown = await thrownBy(async () => {
      throw new Error("boom");
    });

    expect(thrown.data?.[ANCHOR_ERROR]).toEqual(reported);
  });

  /**
   * The status drives the boundary's copy and whether the failure reads as retryable.
   * Hardcoding 500 renders a missing campaign as a server outage.
   */
  it("takes the status from the report rather than assuming a server error", async () => {
    const thrown = await thrownBy(async () => {
      throw new Error("boom");
    });

    expect(thrown.init?.status).toBe(404);
  });

  it("passes the handler's own error to the reporter, not a replacement", async () => {
    const original = new Error("the real cause");

    await thrownBy(async () => {
      throw original;
    });

    expect(reportError.mock.calls[0][0]).toBe(original);
  });
});

describe("the context a failure is filed under", () => {
  /**
   * What makes "is this one merchant or all of them" a query rather than a grep. A
   * constant here files every error in the app under one route.
   */
  it("records the route it was given", async () => {
    await thrownBy(async () => {
      throw new Error("boom");
    }, "/app/prices/baselines");

    expect(reportError.mock.calls[0][1]).toMatchObject({ route: "/app/prices/baselines" });
  });

  it("distinguishes two routes rather than reporting a fixed one", async () => {
    // The subject has to be able to vary, or the assertion above proves nothing — the
    // trap from #533, where two fields could never differ.
    await thrownBy(async () => {
      throw new Error("a");
    }, "/app/one");
    await thrownBy(async () => {
      throw new Error("b");
    }, "/app/two");

    expect([
      reportError.mock.calls[0][1].route,
      reportError.mock.calls[1][1].route,
    ]).toEqual(["/app/one", "/app/two"]);
  });

  it("records the method, so a failed action is not read as a failed page load", async () => {
    await thrownBy(async () => {
      throw new Error("boom");
    });

    expect(reportError.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("takes the shop off the request rather than looking it up", async () => {
    await thrownBy(async () => {
      throw new Error("boom");
    });

    expect(reportError.mock.calls[0][1]).toMatchObject({ shop: "demo.myshopify.com" });
  });
});

describe("enriching the context cannot make things worse", () => {
  /**
   * Best-effort by design: this runs while something is already failing, so a throw here
   * turns one error into two and loses the original — the merchant gets a crash instead
   * of the message and the id that were already computed for them.
   */
  it("still reports when there is no request to read", async () => {
    await withGuard("/app", async () => {
      throw new Error("boom");
    })({} as never).catch(() => {});

    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("still reports when the request URL cannot be parsed", async () => {
    const unparseable = { request: { url: "not a url", method: "GET" } as Request };

    await withGuard("/app", async () => {
      throw new Error("boom");
    })(unparseable as never).catch(() => {});

    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("omits the shop rather than inventing one when the URL carries none", async () => {
    await withGuard("/app", async () => {
      throw new Error("boom");
    })({ request: new Request("https://x.test/app") } as never).catch(() => {});

    expect(reportError.mock.calls[0][1].shop).toBeUndefined();
  });
});
