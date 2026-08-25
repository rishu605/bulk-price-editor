/**
 * Session storage that keeps access tokens encrypted at rest.
 *
 * Wraps the Prisma storage rather than replacing it. The Shopify library owns the
 * session lifecycle and gets it right; the only thing wrong with the default is that a
 * `pg_dump` of the session table yields working `shpua_…` tokens — full write access to
 * every price on a merchant's storefront, for whoever has the backup.
 *
 * Three properties this has to have, and only the first is obvious:
 *
 *   Tokens are ciphertext in the database and plaintext everywhere above this layer, so
 *   nothing else in the app has to remember to decrypt.
 *
 *   It rolls forward over rows written before it existed. A deploy that could not read
 *   yesterday's sessions would sign every merchant out and make the fix look like an
 *   outage. Plaintext rows are read as-is and re-encrypted the next time they are
 *   written.
 *
 *   With no key configured it does nothing at all, visibly. Local development and a
 *   first deploy have no key, and an app that refused to start would be worse than one
 *   that says plainly it is storing tokens in the clear.
 */

import type { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";

import { decryptToken, encryptToken, isEncrypted } from "../lib/crypto/secrets";
import { logger } from "../lib/logging/logger";

export class EncryptedSessionStorage implements SessionStorage {
  private warned = false;

  constructor(
    private readonly inner: SessionStorage,
    private readonly secret: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
  ) {}

  async storeSession(session: Session): Promise<boolean> {
    if (!this.secret) {
      this.warnOnce();
      return this.inner.storeSession(session);
    }

    // Encrypted on a copy. Mutating the caller's session would leave the running
    // request holding ciphertext where it expects a token, and the failure would
    // surface as an authentication error a long way from here.
    return this.inner.storeSession(this.mapToken(session, (token) => encryptToken(token, this.secret!)));
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    return session ? this.decrypt(session) : undefined;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.inner.findSessionsByShop(shop);
    return sessions.map((session) => this.decrypt(session));
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  private decrypt(session: Session): Session {
    if (!session.accessToken) return session;

    // A row written before encryption was switched on. Read as-is and re-encrypted the
    // next time the library saves it, so the table converts itself without a migration
    // window.
    if (!isEncrypted(session.accessToken)) return session;

    if (!this.secret) {
      this.warnOnce();
      // Encrypted rows and no key: the token cannot be recovered here. Returning the
      // session with no token surfaces as NO_SESSION — "reinstall the app" — rather
      // than as ciphertext being sent to Shopify and rejected as an invalid key, which
      // reads like a misconfigured app and sends you looking in the wrong place.
      return this.mapToken(session, () => "");
    }

    const plaintext = decryptToken(session.accessToken, this.secret);
    if (plaintext === null) {
      logger.warn("session token could not be decrypted", { shop: session.shop });
      return this.mapToken(session, () => "");
    }

    return this.mapToken(session, () => plaintext);
  }

  /** Returns a copy of the session with its token replaced. */
  private mapToken(session: Session, map: (token: string) => string): Session {
    const copy = Object.create(Object.getPrototypeOf(session)) as Session;
    Object.assign(copy, session);
    copy.accessToken = map(session.accessToken ?? "");
    return copy;
  }

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    logger.warn(
      "TOKEN_ENCRYPTION_KEY is not set — Shopify access tokens are being stored in plain text. " +
        "A database dump would contain working credentials for every connected store.",
    );
  }
}
