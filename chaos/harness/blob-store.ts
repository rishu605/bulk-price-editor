/**
 * The blob half of the fake: staged upload targets and result files.
 *
 * Split out from the GraphQL half only so `FakeShopify` can depend on the small
 * interface rather than on a server, which keeps it usable from a unit test.
 */

export interface BlobStore {
  /** The URL an uploader should POST a staged file to. */
  uploadUrl(): string;
  /** Publishes a body and returns the URL it can be fetched from. */
  put(key: string, body: string): string;
  get(key: string): string | undefined;
}
