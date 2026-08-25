/**
 * Access token encryption.
 *
 * A stolen database dump should be worthless. Every test here is really one question:
 * can somebody with the table, but not the key, get a working Shopify token out of it?
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { decryptToken, encryptToken, isEncrypted, keyFrom } from "./secrets";

const KEY = "a-secret-of-no-particular-length";
// Shaped like a Shopify token but transparently not one. The original fixture was
// fabricated too, but it was fabricated *convincingly* — which meant every secret
// scanner that ever looked at this repository flagged it, and anyone reading the alert
// had to prove to themselves it was not a live credential before they could dismiss it.
// Making it self-evidently fake costs nothing and saves that.
const TOKEN = "shpua_EXAMPLE_NOT_A_REAL_TOKEN_0000000";

describe("encryptToken / decryptToken", () => {
  it("round-trips a token exactly", () => {
    expect(decryptToken(encryptToken(TOKEN, KEY), KEY)).toBe(TOKEN);
  });

  it("never leaves the token visible in the stored value", () => {
    const stored = encryptToken(TOKEN, KEY);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain("shpua");
  });

  it("produces a different ciphertext every time", () => {
    // A fixed IV with GCM is not a small weakness — it leaks the XOR of two plaintexts
    // and breaks authentication outright, and tokens are re-encrypted on every refresh.
    const a = encryptToken(TOKEN, KEY);
    const b = encryptToken(TOKEN, KEY);
    expect(a).not.toBe(b);
    expect(decryptToken(a, KEY)).toBe(decryptToken(b, KEY));
  });

  it("refuses the wrong key rather than returning rubbish", () => {
    expect(decryptToken(encryptToken(TOKEN, KEY), "a-different-secret")).toBeNull();
  });

  it("refuses a tampered ciphertext", () => {
    // The reason for GCM over CBC. A token altered in the database must fail rather
    // than silently become a different string that gets sent to Shopify.
    const stored = encryptToken(TOKEN, KEY);
    const parts = stored.split(".");
    const flipped = Buffer.from(parts[3], "base64url");
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString("base64url");

    expect(decryptToken(parts.join("."), KEY)).toBeNull();
  });

  it("refuses a tampered authentication tag", () => {
    const parts = encryptToken(TOKEN, KEY).split(".");
    parts[2] = Buffer.from("0".repeat(16)).toString("base64url");
    expect(decryptToken(parts.join("."), KEY)).toBeNull();
  });

  it("returns null for anything that is not our format", () => {
    // Plaintext rows from before encryption, a truncated column, a half-written value.
    expect(decryptToken(TOKEN, KEY)).toBeNull();
    expect(decryptToken("", KEY)).toBeNull();
    expect(decryptToken("v1.only.three", KEY)).toBeNull();
    expect(decryptToken("v2.a.b.c", KEY)).toBeNull();
  });

  it("round-trips any token, of any length or alphabet", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 500 }), (value) => {
        expect(decryptToken(encryptToken(value, KEY), KEY)).toBe(value);
      }),
      { numRuns: 200 },
    );
  });
});

describe("isEncrypted", () => {
  it("tells our format apart from a plaintext token", () => {
    // Existing rows are plaintext. Encryption has to roll forward over a live table:
    // a deploy that could not read yesterday's sessions would sign every merchant out.
    expect(isEncrypted(encryptToken(TOKEN, KEY))).toBe(true);
    expect(isEncrypted(TOKEN)).toBe(false);
    expect(isEncrypted("")).toBe(false);
  });
});

describe("keyFrom", () => {
  it("always produces a 32-byte key, whatever the secret", () => {
    expect(keyFrom("short").length).toBe(32);
    expect(keyFrom("x".repeat(500)).length).toBe(32);
  });

  it("is deterministic, or nothing would ever decrypt after a restart", () => {
    expect(keyFrom(KEY).equals(keyFrom(KEY))).toBe(true);
  });
});
