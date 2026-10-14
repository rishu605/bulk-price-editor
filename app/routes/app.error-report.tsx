/**
 * Where the error screen sends a crash that happened in the browser (#783).
 *
 * A page that crashes while rendering never reaches a loader or an action, so the server
 * guard never stores it. The boundary posts it here instead, under the reference it is
 * already showing, so that reference resolves on the Diagnostics page.
 *
 * A resource route: no component. The boundary's `fetch` is signed with the session token
 * by App Bridge, so the shop is the authenticated session's — the body names no shop, and
 * nothing here would read one if it did.
 *
 * Answers `{ stored }` and nothing else. The screen claims its reference leads to the
 * technical detail only when this says `stored: true`.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { recordBrowserError } from "../services/error-report.server";
import { withGuard } from "../lib/errors/guard.server";
import { browserReportFrom, MAX_BODY_CHARS } from "../lib/errors/browser-report";

const STATUS = { stored: 200, throttled: 429, unstored: 409 } as const;

export const action = withGuard("/app/error-report", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST") return answer(false, 405);

  // Bounded before it is read. A report is a few kilobytes; a body past this is not one.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_CHARS) return answer(false, 413);
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return answer(false, 413);

  const report = browserReportFrom(parsed(text));
  if (!report) return answer(false, 400);

  const shop = await ensureShop(session.shop);
  const outcome = await recordBrowserError(shop, report);
  return answer(outcome === "stored", STATUS[outcome]);
});

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function answer(stored: boolean, status: number): Response {
  return Response.json({ stored }, { status });
}
