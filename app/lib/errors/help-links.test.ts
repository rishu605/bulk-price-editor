/**
 * Linking every error to the page that explains it.
 *
 * The acceptance criterion that makes a help centre real rather than a wiki nobody
 * reads. A broken link under an error message is worse than no link at all: it confirms
 * the merchant's suspicion that nobody is looking after this.
 */

import { describe, expect, it } from "vitest";

import { helpLabelFor, helpUrlFor } from "./help-links";

const CODES = [
  "UNAUTHENTICATED",
  "NO_SESSION",
  "SHOPIFY_THROTTLED",
  "SHOPIFY_UNAVAILABLE",
  "SHOPIFY_REJECTED",
  "GUARDRAIL_BLOCKED",
  "NOT_FOUND",
  "VALIDATION",
  "DB_UNAVAILABLE",
  "UNKNOWN",
] as const;

describe("help links", () => {
  it("gives every error code a real path", () => {
    for (const code of CODES) {
      const url = helpUrlFor(code);

      expect(url).not.toContain("undefined");
      expect(url).toMatch(/^https?:\/\/.+\/.+/);
    }
  });

  it("gives every error code a distinct page", () => {
    // Sending four different failures to the same page would be a link that technically
    // exists and answers nothing.
    const urls = CODES.map(helpUrlFor);

    expect(new Set(urls).size).toBe(CODES.length);
  });

  it("falls back to the general page for a code it does not know", () => {
    // The code crosses a serialisation boundary as a plain string. A future or
    // mistyped one must not produce ".../undefined".
    expect(helpUrlFor("SOMETHING_NEW")).toBe(helpUrlFor("UNKNOWN"));
    expect(helpUrlFor("")).not.toContain("undefined");
  });

  it("labels the link with what it explains, never with the URL", () => {
    for (const code of CODES) {
      const label = helpLabelFor(code);

      expect(label.length).toBeGreaterThan(0);
      expect(label.toLowerCase()).not.toContain("http");
      expect(label.toLowerCase()).not.toContain("click here");
    }
  });
});
