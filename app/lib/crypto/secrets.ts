/**
 * Encrypting Shopify access tokens at rest.
 *
 * A stolen database dump should be worthless. Right now it is not: the session table
 * holds `shpua_…` tokens in plaintext, and any one of them is full write access to a
 * merchant's catalogue — every price on the storefront, changeable by whoever has the
 * backup. That is the single worst thing this app could leak, and it is sitting in a
 * column that a `pg_dump` copies without comment.
 *
 * AES-256-GCM, because the token has to come back out and it has to come back out
 * *unmodified*. GCM authenticates as well as encrypts, so a token altered in the
 * database fails to decrypt rather than silently becoming a different string that gets
 * sent to Shopify.
 *
 * A fresh random IV per encryption, never a fixed one. Reusing an IV with GCM is not a
 * small weakness — it leaks the XOR of two plaintexts and breaks the authentication
 * outright, and tokens for the same shop are re-encrypted on every refresh.
 *
 * The stored form carries its own version tag, so a future key rotation or algorithm
 * change can be told apart from ciphertext written today rather than guessed at.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export class MissingKeyError extends Error {
  constructor() {
    super(
      "TOKEN_ENCRYPTION_KEY is not set. Access tokens cannot be stored safely without it.",
    );
    this.name = "MissingKeyError";
  }
}

/**
 * Derives the 32-byte key from the configured secret.
 *
 * Hashed rather than used raw so any secret length works, and so a secret that happens
 * to be 32 characters of low entropy is not silently treated as a good key.
 */
export function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** True when the deployment is configured to encrypt. */
export function encryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TOKEN_ENCRYPTION_KEY);
}

/**
 * Encrypts a token.
 *
 * The output is `v1.<iv>.<tag>.<ciphertext>`, all base64url. Self-describing on purpose:
 * whoever has to reason about this column in three years should be able to tell what
 * they are looking at without finding this file first.
 */
export function encryptToken(plaintext: string, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join(".");
}

/**
 * Decrypts a token, or returns null.
 *
 * Null rather than throwing, and the caller treats it as "no usable session" — which is
 * already an expected state for an uninstalled shop. A token that will not decrypt is
 * one we cannot use, and the remedy is the same either way: reinstall. Throwing would
 * turn a bad row into a 500 on every request for that shop.
 */
export function decryptToken(stored: string, secret: string): string | null {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const [, iv, tag, ciphertext] = parts;
    const decipher = createDecipheriv(ALGORITHM, keyFrom(secret), unb64(iv));
    decipher.setAuthTag(unb64(tag));

    return Buffer.concat([decipher.update(unb64(ciphertext)), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, tampered ciphertext, or a truncated column. All three mean the same
    // thing to the caller.
    return null;
  }
}

/**
 * Whether a stored value is already encrypted.
 *
 * Needed because existing rows are plaintext. Encryption has to roll forward over a
 * live table without a migration window — a deploy that could not read yesterday's
 * sessions would sign every merchant out.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split(".").length === 4;
}

const b64 = (buffer: Buffer) => buffer.toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");
