import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { describe, expect, it } from "vitest";

import { isEncrypted } from "../lib/crypto/secrets";
import { EncryptedSessionStorage } from "./encrypted-session-storage.server";

const KEY = "k".repeat(48);

/** What the wrapped Prisma storage holds, row for row. */
function memory() {
  const rows = new Map<string, Session>();
  const inner: SessionStorage = {
    storeSession: async (session) => (rows.set(session.id, session), true),
    loadSession: async (id) => rows.get(id),
    deleteSession: async (id) => rows.delete(id),
    deleteSessions: async (ids) => (ids.forEach((id) => rows.delete(id)), true),
    findSessionsByShop: async (shop) => [...rows.values()].filter((row) => row.shop === shop),
  };
  return { inner, rows };
}

const offline = () =>
  new Session({
    id: "offline_shop.myshopify.com",
    shop: "shop.myshopify.com",
    state: "",
    isOnline: false,
    accessToken: "shpua_access",
    refreshToken: "shprt_refresh",
  });

describe("EncryptedSessionStorage", () => {
  it("stores both tokens as ciphertext, and hands both back as plaintext (#707)", async () => {
    // With expiring offline tokens the refresh token outlives every access token, so a
    // dump holding it in the clear could mint fresh access for months.
    const { inner, rows } = memory();
    const storage = new EncryptedSessionStorage(inner, KEY);

    await storage.storeSession(offline());
    const row = rows.get("offline_shop.myshopify.com")!;
    expect(isEncrypted(row.accessToken!)).toBe(true);
    expect(isEncrypted(row.refreshToken!), "refresh token stored in the clear").toBe(true);

    const loaded = await storage.loadSession("offline_shop.myshopify.com");
    expect(loaded?.accessToken).toBe("shpua_access");
    expect(loaded?.refreshToken).toBe("shprt_refresh");
    expect(loaded?.isOnline).toBe(false);
  });

  it("does not encrypt the caller's own session object", async () => {
    const { inner } = memory();
    const session = offline();
    await new EncryptedSessionStorage(inner, KEY).storeSession(session);
    expect(session.accessToken).toBe("shpua_access");
    expect(session.refreshToken).toBe("shprt_refresh");
  });

  it("reads a row written before encryption as it is", async () => {
    const { inner, rows } = memory();
    rows.set("offline_shop.myshopify.com", offline());
    const loaded = await new EncryptedSessionStorage(inner, KEY).loadSession("offline_shop.myshopify.com");
    expect(loaded?.refreshToken).toBe("shprt_refresh");
  });

  it("returns no token, never ciphertext, when there is no key to read it with", async () => {
    const { inner } = memory();
    await new EncryptedSessionStorage(inner, KEY).storeSession(offline());
    const loaded = await new EncryptedSessionStorage(inner, undefined).loadSession("offline_shop.myshopify.com");
    expect(loaded?.accessToken).toBe("");
    expect(loaded?.refreshToken).toBe("");
  });
});
