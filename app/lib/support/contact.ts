/**
 * The address a merchant can always write to, whatever this deployment can send.
 *
 * Contact support sends through a mail provider, and a deployment without one could only
 * say "not configured on this install. Nothing was sent." -- to a merchant who cannot
 * configure anything, at the moment they most need help, with no other way to reach us
 * (#758). Every failure to send names this address, and the support page shows it.
 *
 * One constant because three pages published it separately: login, privacy and support.
 */
export const SUPPORT_ADDRESS = "rishu605@gmail.com";

/** A `mailto:` link for it, with a subject when there is one. */
export function supportMailto(subject?: string): string {
  return subject
    ? `mailto:${SUPPORT_ADDRESS}?subject=${encodeURIComponent(subject)}`
    : `mailto:${SUPPORT_ADDRESS}`;
}
