/**
 * The worker's route to an access token.
 *
 * This path never goes through the session storage that encrypts tokens — the web
 * process gets its token from Shopify's session machinery, the worker reads the row
 * directly. Which is exactly how it came to send ciphertext as a bearer token, breaking
 * every scheduled run, the nightly mirror audit and the reconciliation spot check at
 * once, all with the same misleading "Invalid API key or access token".
 */

import { describe, expect, it } from "vitest";

import { encryptToken } from "../lib/crypto/secrets";
import { decryptedToken, operationName } from "./admin-client.server";

const KEY = "a-test-key-for-this-file-only";

describe("reading a stored token", () => {
  it("decrypts a token that was stored encrypted", () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    const stored = encryptToken("shpua_EXAMPLE_NOT_A_REAL_TOKEN_0000000", KEY);

    expect(decryptedToken(stored)).toBe("shpua_EXAMPLE_NOT_A_REAL_TOKEN_0000000");
  });

  it("passes a plaintext token through unchanged", () => {
    // A shop installed before encryption keeps working until its token is next
    // rewritten. Roll-forward, not a migration.
    process.env.TOKEN_ENCRYPTION_KEY = KEY;

    expect(decryptedToken("shpua_EXAMPLE_NOT_A_REAL_TOKEN_0000000")).toBe(
      "shpua_EXAMPLE_NOT_A_REAL_TOKEN_0000000",
    );
  });

  it("refuses an encrypted token when there is no key, rather than sending ciphertext", () => {
    const stored = encryptToken("shpua_EXAMPLE_NOT_A_REAL_TOKEN_0000000", KEY);
    delete process.env.TOKEN_ENCRYPTION_KEY;

    // Null, so the caller reports "no session" — which points at this app. Sending the
    // ciphertext makes Shopify report an authentication failure, which points at the
    // API credentials and wastes the afternoon.
    expect(decryptedToken(stored)).toBeNull();
  });

  it("refuses an encrypted token when the key is wrong", () => {
    const stored = encryptToken("shpua_EXAMPLE_NOT_A_REAL_TOKEN_0000000", KEY);
    process.env.TOKEN_ENCRYPTION_KEY = "a-different-key-entirely";

    expect(decryptedToken(stored)).toBeNull();
  });
});


describe("naming a GraphQL operation for a span", () => {
  it("takes the operation name from the document", () => {
    expect(operationName("#graphql\n  mutation AnchorPriceListUpdate($id: ID!) { … }")).toBe(
      "AnchorPriceListUpdate",
    );
    expect(operationName("query AnchorPriceLists($cursor: String) { … }")).toBe(
      "AnchorPriceLists",
    );
  });

  it("never returns the document itself", () => {
    // A price mutation's variables are exactly what must not be exported, and a query
    // body as a span attribute is both enormous and unhelpful.
    const document = "mutation AnchorX { productVariantsBulkUpdate(price: \"19.99\") { id } }";

    expect(operationName(document)).toBe("AnchorX");
    expect(operationName(document)).not.toContain("19.99");
  });

  it("names an anonymous document rather than returning undefined", () => {
    // An attribute of "undefined" makes a dashboard filter on something that looks
    // present and is not.
    expect(operationName("{ shop { name } }")).toBe("anonymous");
  });
});
