/**
 * Linking every error to the page that explains it.
 *
 * The acceptance criterion that makes a help centre real rather than a wiki nobody
 * reads. A broken link under an error message is worse than no link at all: it confirms
 * the merchant's suspicion that nobody is looking after this.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { helpLabelFor, helpPathFor } from "./help-links";
import { helpUrlFor } from "./help-links.server";

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

/**
 * Where the links point is configuration, and getting it wrong is silent: the app keeps
 * rendering links, they just go nowhere. `HELP_BASE` is read once at import, so each case
 * sets the environment and re-imports.
 */
describe("where help links point", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  async function baseWith(env: Record<string, string | undefined>) {
    process.env = { ...original, ...env };
    vi.resetModules();
    return (await import("./help-links.server")).HELP_BASE;
  }

  it("points at this deploy's own help route by default", async () => {
    expect(await baseWith({ HELP_BASE_URL: undefined, SHOPIFY_APP_URL: "https://anchor.example" }))
      .toBe("https://anchor.example/help");
  });

  it("does not double the slash when the app URL has a trailing one", async () => {
    expect(
      await baseWith({ HELP_BASE_URL: undefined, SHOPIFY_APP_URL: "https://anchor.example/" }),
    ).toBe("https://anchor.example/help");
  });

  it("uses an override verbatim, because independent hosting serves from its own root", async () => {
    // Not `.../help/help`: the reason to set this is to move the failure docs off the app
    // they describe, and that host has no reason to nest them.
    expect(await baseWith({ HELP_BASE_URL: "https://help.example" })).toBe("https://help.example");
  });

  it("stays absolute even with nothing configured", async () => {
    // A relative base renders inside the Shopify admin's iframe and resolves against
    // admin.shopify.com — a dead link with somebody else's domain on it.
    const base = await baseWith({ HELP_BASE_URL: undefined, SHOPIFY_APP_URL: undefined });

    expect(base).toMatch(/^https?:\/\//);
  });

  it("ignores a configured value that is not a URL", async () => {
    expect(await baseWith({ HELP_BASE_URL: "", SHOPIFY_APP_URL: "localhost:3000" })).toMatch(
      /^https?:\/\//,
    );
  });
});

describe("the link a browser renders", () => {
  it("is root-relative, so it resolves to whichever host is serving the app", () => {
    for (const code of CODES) {
      const path = helpPathFor(code);

      expect(path.startsWith("/help/"), `${code} rendered ${path}`).toBe(true);
      expect(path).not.toContain("undefined");
      // An absolute URL here would have been built from `process.env`, which Vite empties
      // out in the client bundle — the merchant would see localhost.
      expect(path).not.toMatch(/^https?:/);
      expect(path).not.toContain("localhost");
    }
  });

  it("agrees with the absolute form about which page it means", () => {
    for (const code of CODES) {
      expect(helpUrlFor(code).endsWith(helpPathFor(code).slice("/help".length))).toBe(true);
    }
  });
});
