/**
 * `adminClientForShop` goes through the Shopify library, which refreshes an expired
 * offline token, rather than reading the Session row and skipping it (#707).
 *
 * The refresh itself is the library's, against Shopify's own OAuth endpoint; what is ours
 * is that every background path reaches it, and what happens when it cannot.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./../shopify.server");
});

describe("adminClientForShop", () => {
  it("builds the client from the library's refreshing offline session", async () => {
    const graphql = vi.fn(async () => ({ json: async () => ({ data: { shop: { name: "x" } } }) }));
    const admin = vi.fn(async (shop: string) => {
      expect(shop).toBe("shop.myshopify.com");
      return { admin: { graphql }, session: {} };
    });
    vi.doMock("./../shopify.server", () => ({ unauthenticated: { admin } }));

    const { adminClientForShop } = await import("./admin-client.server");
    const client = await adminClientForShop("shop.myshopify.com");

    expect(client).not.toBeNull();
    const result = await client!.request<{ shop: { name: string } }>("query Shop { shop { name } }", {});
    expect(result.data?.shop.name).toBe("x");
    expect(admin).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("answers no session when Shopify refuses the refresh (revoked, uninstalled)", async () => {
    vi.doMock("./../shopify.server", () => ({
      unauthenticated: {
        admin: async () => {
          throw new Response(undefined, { status: 401 });
        },
      },
    }));

    const { adminClientForShop } = await import("./admin-client.server");
    expect(await adminClientForShop("shop.myshopify.com")).toBeNull();
  });

  it("answers no session when there is no offline session at all", async () => {
    vi.doMock("./../shopify.server", () => ({
      unauthenticated: {
        admin: async () => {
          throw new Error("Could not find a session for shop shop.myshopify.com");
        },
      },
    }));

    const { adminClientForShop } = await import("./admin-client.server");
    expect(await adminClientForShop("shop.myshopify.com")).toBeNull();
  });
});
