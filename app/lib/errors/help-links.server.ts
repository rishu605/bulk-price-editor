/**
 * The absolute form of a help link, for anywhere that is not a browser.
 *
 * Separate from `help-links.ts` because that module is imported by components, and Vite
 * replaces `process.env` with an empty object in the client bundle — an environment read
 * that compiles there silently produces `http://localhost:3000/...` on a merchant's
 * screen. Keeping the read in a `.server` module makes that a build error instead.
 */

import { helpPathOf, HELP_ROUTE } from "./help-links";

/**
 * Where help URLs are rooted, always absolute and never with a trailing slash.
 *
 * `HELP_BASE_URL` is used verbatim, because independent hosting serves the docs at its own
 * root rather than under `/help`. Otherwise the base is this deploy's own help route — the
 * previous default named a domain nobody had registered, so every link led nowhere.
 *
 * The reason to set the override is not staging. Serving help from the app means
 * `failures/app-unavailable` is unavailable exactly when a merchant needs it; independent
 * hosting fixes that without touching a call site. The dev fallback matches `.env.example`,
 * and reaching it in production would mean `SHOPIFY_APP_URL` is unset, which breaks OAuth
 * long before it breaks a help link.
 */
export const HELP_BASE = helpBase();

function helpBase(): string {
  const override = absolute(process.env.HELP_BASE_URL);
  if (override) return override;

  return `${absolute(process.env.SHOPIFY_APP_URL) ?? "http://localhost:3000"}${HELP_ROUTE}`;
}

function absolute(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");

  return trimmed && /^https?:\/\/.+/.test(trimmed) ? trimmed : null;
}

/** The full URL for an error's doc. Use `helpPathFor` in anything the browser renders. */
export function helpUrlFor(code: string): string {
  return `${HELP_BASE}${helpPathOf(code)}`;
}
