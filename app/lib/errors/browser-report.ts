/**
 * Sending a browser-side crash to the server, so its reference is one Diagnostics can find
 * (#783).
 *
 * A page that crashes while rendering in the browser never reaches a loader or an action,
 * so the server guard never sees it. The boundary mints a reference on the spot, and for a
 * long time that reference was only logged in the browser: the error screen told the
 * merchant it "links straight to the full technical detail", and Diagnostics answered "No
 * error stored" when they quoted it.
 *
 * Isomorphic, like `report.ts`. The boundary builds the report here and posts it, and the
 * endpoint reads the body back through the same functions — so what the server accepts is
 * the shape the browser sends, and neither can drift from the other.
 *
 * ## What it carries, and what it does not
 *
 * The reference, the code, the page's path and the stack's frames. Not the error's
 * message: a thrown message is whatever the code that threw put in it, and that can be a
 * price. The first lines of a V8 stack *are* the message, so the stack is cut down to its
 * frames — the lines that say where, which are code locations rather than data.
 */

import { isErrorCode, type ErrorCode } from "./app-error";
import { isErrorId } from "./error-id";

/** Where the boundary posts. A resource route under `/app`, so App Bridge signs the fetch. */
export const BROWSER_REPORT_PATH = "/app/error-report";

/** Frames kept. The top of a stack is where the fault is; the bottom is React's own machinery. */
export const MAX_FRAMES = 40;

/** The stack's ceiling in characters, after the frames are picked. */
export const MAX_STACK_CHARS = 4_000;

/** A path is a path; past this it is something else. */
export const MAX_ROUTE_CHARS = 200;

/** The body the endpoint will read at all. A report is a few kilobytes at most. */
export const MAX_BODY_CHARS = 16_384;

/**
 * Distinct reports one page load sends.
 *
 * Each reference is sent once however often the screen renders, so this only bites when
 * many different errors arrive: a crash loop that re-mounts the boundary. Past it they are
 * shown as unrecorded rather than sent, and the server keeps its own hourly ceiling for
 * the loop that reloads the page.
 */
export const REPORTS_PER_PAGE = 5;

/** How long the screen waits for an answer before saying the reference was not recorded. */
export const REPORT_TIMEOUT_MS = 10_000;

export interface BrowserReport {
  errorId: string;
  code: ErrorCode;
  /** The page's path, without its query string or fragment. */
  route: string | null;
  /** The error's class — `TypeError`, `RangeError` — which is code, never data. */
  name: string | null;
  /** Frames only. Null when there are none, as for an error that came from the server's render. */
  stack: string | null;
}

/**
 * Whether the reference on the error screen is one support can look up.
 *
 * `recorded` for anything the server guard reported, and for a browser report the server
 * confirmed it stored. `recording` while the report is on its way, `unrecorded` once it
 * failed or was never sent.
 */
export type ReferenceState = "recorded" | "recording" | "unrecorded";

/** The report the boundary sends for an error it reported in the browser. */
export function browserReportOf(
  error: unknown,
  reported: { errorId: string; code: string },
  pathname: string | undefined,
): BrowserReport {
  return {
    errorId: reported.errorId,
    code: isErrorCode(reported.code) ? reported.code : "UNKNOWN",
    route: routeOf(pathname),
    name: nameOf(error instanceof Error ? error.name : null),
    stack: framesOf(error instanceof Error ? error.stack : null),
  };
}

/**
 * Reads a posted body back into a report, or null when it is not one.
 *
 * The browser is not trusted to have sent what `browserReportOf` builds, so every field is
 * checked again here. A malformed reference is refused outright, because storing it would
 * hold a row nobody can look up. Everything else is narrowed rather than refused: an
 * unknown code is UNKNOWN, an oversized stack is cut, a route that is not a path is
 * dropped. Nothing in the body names the shop, and nothing here would read it if it did.
 */
export function browserReportFrom(body: unknown): BrowserReport | null {
  if (!body || typeof body !== "object") return null;
  const fields = body as Record<string, unknown>;

  const errorId = typeof fields.errorId === "string" && fields.errorId.length <= 20 ? fields.errorId : "";
  if (!isErrorId(errorId)) return null;

  return {
    errorId: errorId.trim().toUpperCase(),
    code: isErrorCode(fields.code) ? fields.code : "UNKNOWN",
    route: routeOf(fields.route),
    name: nameOf(fields.name),
    stack: framesOf(fields.stack),
  };
}

/**
 * A stack's frames, and nothing else.
 *
 * V8 writes `Name: message` before its `at …` lines, and the message can carry anything
 * the throwing code put in it. Firefox and Safari write `fn@url:line:col` with no header.
 * Keeping only lines in one of those two shapes drops the message in both, and bounds the
 * result whatever arrived.
 */
export function framesOf(stack: unknown): string | null {
  if (typeof stack !== "string" || stack.length === 0) return null;

  const frames = stack
    .slice(0, MAX_BODY_CHARS * 2)
    .split("\n")
    .map((line) => line.trimEnd().slice(0, 300))
    .filter((line) => V8_FRAME.test(line) || OTHER_FRAME.test(line))
    .slice(0, MAX_FRAMES);

  return frames.length > 0 ? frames.join("\n").slice(0, MAX_STACK_CHARS) : null;
}

const V8_FRAME = /^\s*at\s+\S/;
const OTHER_FRAME = /@(?:\S*:\d+:\d+|\[native code\])$/;

function routeOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.split(/[?#]/)[0];
  return path.startsWith("/") ? path.slice(0, MAX_ROUTE_CHARS) : null;
}

function nameOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z_$][\w$]{0,59}$/.test(value) ? value : null;
}

/**
 * Posts one report and says whether the server stored it.
 *
 * `recorded` only on the server's own word: a 200 whose body says `stored`. A redirect to
 * the login page also answers 200, with HTML, which is why the body is read rather than
 * the status trusted. Never throws — this runs on a screen that is already the app failing.
 */
export async function postBrowserReport(
  report: BrowserReport,
  send: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<Exclude<ReferenceState, "recording">> {
  try {
    const response = await send(BROWSER_REPORT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REPORT_TIMEOUT_MS) : undefined,
    });
    if (!response.ok) return "unrecorded";
    const answer = (await response.json()) as { stored?: unknown } | null;
    return answer?.stored === true ? "recorded" : "unrecorded";
  } catch {
    return "unrecorded";
  }
}

/**
 * A sender that posts each reference once, and at most `limit` of them.
 *
 * The screen re-renders, and React runs an effect twice in development, so the same
 * reference is asked for more than once; each ask gets the first one's answer. A new
 * reference past the limit is not sent at all.
 */
export function onceEach(
  send: (report: BrowserReport) => Promise<Exclude<ReferenceState, "recording">>,
  limit = REPORTS_PER_PAGE,
) {
  const sent = new Map<string, Promise<Exclude<ReferenceState, "recording">>>();

  return (report: BrowserReport): Promise<Exclude<ReferenceState, "recording">> => {
    const earlier = sent.get(report.errorId);
    if (earlier) return earlier;
    if (sent.size >= limit) return Promise.resolve("unrecorded");

    const outcome = send(report);
    sent.set(report.errorId, outcome);
    return outcome;
  };
}

/** The page's one sender. */
export const reportBrowserError = onceEach((report) => postBrowserReport(report));
