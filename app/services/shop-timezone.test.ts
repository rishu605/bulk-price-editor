/**
 * Reading the store's zone from Shopify (#799).
 *
 * The answer decides every time a merchant types, so anything short of a zone Intl can
 * convert in reads as "Shopify did not say" -- and the editor refuses to convert rather
 * than falling back to UTC, which is what put a New York store's 9 AM sale at 4 AM.
 */

import { describe, expect, it } from "vitest";

import type { AdminClient } from "../lib/execution/sync-executor";
import { readShopTimezone, SHOP_TIMEZONE_QUERY, unknownZoneMessage } from "./shop-timezone.server";

function answering(shop: unknown): AdminClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async request<T>(query: string) {
      asked.push(query);
      return { data: { shop } as T };
    },
  };
}

describe("readShopTimezone", () => {
  it("returns the zone Shopify has for the store", async () => {
    const client = answering({ ianaTimezone: "America/New_York" });
    expect(await readShopTimezone(client)).toBe("America/New_York");
    expect(client.asked).toEqual([SHOP_TIMEZONE_QUERY]);
  });

  it.each([
    ["no zone", {}],
    ["a null zone", { ianaTimezone: null }],
    ["an empty zone", { ianaTimezone: "" }],
    ["a zone nothing can convert in", { ianaTimezone: "Mars/Olympus" }],
    ["no shop at all", null],
  ])("says it does not know on %s, rather than guessing UTC", async (_label, shop) => {
    expect(await readShopTimezone(answering(shop))).toBeNull();
  });

  it("says it does not know when the request fails", async () => {
    const failing: AdminClient = {
      async request() {
        throw new Error("Service Unavailable");
      },
    };
    expect(await readShopTimezone(failing)).toBeNull();
  });
});

describe("the refusal when the zone is unknown", () => {
  it("names the field, the cause, what was not done and what to do next", () => {
    expect(unknownZoneMessage("Start", "Nothing was created.")).toBe(
      "Start: Anchor couldn't read your store's time zone from Shopify just now, so it can't tell when a time " +
        "you type would be. Nothing was created. Try again in a minute, or leave the dates empty and apply the " +
        "campaign by hand.",
    );
  });
});
