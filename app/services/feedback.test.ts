/**
 * Recording feedback, and what a merchant is told about it.
 *
 * The status wording is the part worth testing. A beta merchant keeps talking to you for
 * exactly as long as talking to you appears to change something, and an item that sits
 * looking unread for ever is how a beta programme becomes a suggestion box.
 */

import { describe, expect, it } from "vitest";

import { isSentiment, MAX_MESSAGE, SENTIMENTS } from "./feedback.server";

describe("sentiments", () => {
  it("offers three, because a longer list makes people stop and choose", () => {
    expect(SENTIMENTS).toHaveLength(3);
  });

  it("recognises the three and nothing else", () => {
    for (const sentiment of SENTIMENTS) {
      expect(isSentiment(sentiment)).toBe(true);
    }

    expect(isSentiment("bug")).toBe(false);
    expect(isSentiment("")).toBe(false);
    expect(isSentiment(undefined)).toBe(false);
  });
});

describe("message length", () => {
  it("allows a long message rather than a tweet", () => {
    // Somebody describing a pricing problem properly needs room. A limit that forces
    // them to edit is a limit that gets them a shorter, less useful report.
    expect(MAX_MESSAGE).toBeGreaterThanOrEqual(2_000);
  });
});
