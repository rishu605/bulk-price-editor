/**
 * What is wrong with the address a support reply goes to, or null when nothing is.
 *
 * Two different problems, said as two (#759). An address that is there but is not an
 * address was answered "We need an address to reply to" -- the message for an empty
 * field, read by a merchant looking at the text they had typed into it. Quoting what they
 * typed is what makes the cause visible.
 *
 * Deliberately loose: something, an @, something, a dot, something. A stricter pattern
 * refuses real addresses, and the mail provider is the one that knows.
 */
export function replyToProblem(value: string): string | null {
  const address = value.trim();
  if (!address) return "Add the email address we should reply to, then send again.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return `"${address}" is not an email address. Check it reads like you@yourstore.com, then send again.`;
  }
  return null;
}
