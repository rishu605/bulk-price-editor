/**
 * Reading the app's own handle, and what happens when Shopify does not answer.
 *
 * The handle is the only variable part of the managed-pricing link. It comes from the API
 * rather than from configuration because an env var is a second copy of a fact Shopify
 * owns: set once, forgotten, then wrong after a rename, and the symptom is a 404 on the
 * page where somebody was about to pay.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { APP_HANDLE_QUERY, appHandle, resetAppHandleCache } from "./app-handle.server";
import type { AdminClient } from "../lib/execution/sync-executor";

function client(impl: AdminClient["request"]): AdminClient {
  return { request: impl as AdminClient["request"] };
}

beforeEach(() => {
  resetAppHandleCache();
});

describe("the app's handle", () => {
  it("comes back from the current installation", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { currentAppInstallation: { app: { handle: "anchor-pricing" } } },
    });

    await expect(appHandle(client(request))).resolves.toBe("anchor-pricing");
    expect(request).toHaveBeenCalledWith(APP_HANDLE_QUERY, {});
  });

  it("is asked for once per process", async () => {
    // The plan page renders on every visit and the handle changes on a rename, which is
    // a deploy-shaped event. One call, not one per render.
    const request = vi.fn().mockResolvedValue({
      data: { currentAppInstallation: { app: { handle: "anchor-pricing" } } },
    });
    const admin = client(request);

    await appHandle(admin);
    await appHandle(admin);
    await appHandle(admin);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("is null when the query throws, and the failure is not retried on every render", async () => {
    const request = vi.fn().mockRejectedValue(new Error("throttled"));
    const admin = client(request);

    await expect(appHandle(admin)).resolves.toBeNull();
    await expect(appHandle(admin)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("is null when the installation answers without a handle", async () => {
    for (const data of [
      {},
      { currentAppInstallation: null },
      { currentAppInstallation: { app: null } },
      { currentAppInstallation: { app: { handle: null } } },
    ]) {
      resetAppHandleCache();
      await expect(appHandle(client(vi.fn().mockResolvedValue({ data })))).resolves.toBeNull();
    }
  });
});
