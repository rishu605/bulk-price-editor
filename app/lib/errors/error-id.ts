/**
 * Short ids a person can read out over the phone.
 *
 * The merchant sees this on the error screen and quotes it in a support message; we
 * search the logs for the same string and land on the full stack. That handoff only
 * works if the id survives being transcribed by hand, so the alphabet excludes the
 * characters people confuse: no O/0, no I/1/L, no U (which turns into V in
 * handwriting).
 *
 * Not a UUID, deliberately -- nobody reads a UUID out correctly, and this needs to be
 * unique among the errors of one app, not among all objects in the universe.
 */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newErrorId(): string {
  const bytes = randomBytes(8);
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return `ANC-${id.slice(0, 4)}-${id.slice(4)}`;
}

function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  const cryptoApi = globalThis.crypto;

  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(out);
    return out;
  }

  // Only reachable on a runtime without WebCrypto. An id that repeats is a nuisance
  // when searching logs, never a security problem -- these are not secrets.
  for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** True for something that looks like one of our ids, for the debug page's search. */
export function isErrorId(value: string): boolean {
  return /^ANC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(value.trim().toUpperCase());
}
