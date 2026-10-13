/**
 * Whether there is a catalogue to price yet (#800): the difference between "your
 * conditions match nothing" and "Anchor has not read your store".
 */

import { describe, expect, it } from "vitest";

import { catalogueNotice, catalogueStateFrom } from "./state";

describe("the catalogue's state", () => {
  it("is ready with any variant at all, even while a first sync is still running", () => {
    expect(catalogueStateFrom({ variants: 12, synced: false, syncing: true })).toBe("ready");
  });

  it("is unsynced on a store that has never been read", () => {
    expect(catalogueStateFrom({ variants: 0, synced: false, syncing: false })).toBe("unsynced");
  });

  it("is syncing while the first sync runs and nothing has landed yet", () => {
    expect(catalogueStateFrom({ variants: 0, synced: false, syncing: true })).toBe("syncing");
  });

  it("is empty on a store that has been read and has no products", () => {
    expect(catalogueStateFrom({ variants: 0, synced: true, syncing: false })).toBe("empty");
  });
});

describe("what the merchant is told", () => {
  it("is nothing when there is a catalogue: the conditions message stands", () => {
    expect(catalogueNotice("ready")).toBeNull();
  });

  it.each(["unsynced", "syncing", "empty"] as const)("names the cause and where to go when %s", (state) => {
    const notice = catalogueNotice(state)!;
    expect(notice.action.href).toBe("/app");
    expect(notice.description).not.toMatch(/condition|loosen/i);
  });

  it("says to sync, and how long it takes, on a store never read", () => {
    expect(catalogueNotice("unsynced")!.description).toMatch(/^Campaigns price the products Anchor has read.*Sync your catalogue from Home/);
  });
});
