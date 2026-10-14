/**
 * What a browser crash report carries, and when the screen may trust it (#783).
 *
 * The chaos scenario `browser-error-report` proves the endpoint stores a report and
 * Diagnostics finds it. These are the browser's half: that the report never carries the
 * thrown message (the one place a price can hide), that the server reads back only what
 * the browser is allowed to send, and that the screen hears "recorded" only on the server's
 * own word.
 */

import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_REPORT_PATH,
  browserReportFrom,
  browserReportOf,
  framesOf,
  MAX_FRAMES,
  MAX_STACK_CHARS,
  onceEach,
  postBrowserReport,
  type BrowserReport,
} from "./browser-report";
import { isErrorId, newErrorId } from "./error-id";

const V8_STACK = [
  "TypeError: Could not show 19.99 for variant 4412",
  "  and a second line of message, 24.00",
  "    at CampaignPage (https://anchor.example/assets/app.campaigns._id-B1x.js:1:2345)",
  "    at renderWithHooks (https://anchor.example/assets/chunk-react.js:3:400)",
  "    at Array.map (<anonymous>)",
].join("\n");

const SAFARI_STACK = [
  "CampaignPage@https://anchor.example/assets/app.campaigns._id-B1x.js:1:2345",
  "map@[native code]",
  "renderWithHooks@https://anchor.example/assets/chunk-react.js:3:400",
].join("\n");

function errorWith(stack: string, message = "Could not show 19.99 for variant 4412"): Error {
  const error = new TypeError(message);
  error.stack = stack;
  return error;
}

function report(over: Partial<BrowserReport> = {}): BrowserReport {
  return { errorId: newErrorId(), code: "UNKNOWN", route: "/app", name: "TypeError", stack: null, ...over };
}

describe("the report the boundary sends", () => {
  it("keeps the stack's frames and drops its header, which is the thrown message", () => {
    const sent = browserReportOf(errorWith(V8_STACK), { errorId: "ANC-K3M2-P7QR", code: "UNKNOWN" }, "/app/campaigns/c1");

    expect(sent.stack).toContain("at CampaignPage");
    expect(sent.stack).toContain("at Array.map (<anonymous>)");
    expect(sent.stack, "the message's first line was sent").not.toContain("19.99");
    expect(sent.stack, "the message's second line was sent").not.toContain("24.00");
    expect(JSON.stringify(sent), "the thrown message went out some other way").not.toContain("Could not show");
  });

  it("keeps Firefox and Safari frames, which have no header to drop", () => {
    expect(framesOf(SAFARI_STACK)).toBe(SAFARI_STACK);
  });

  it("sends the page's path without its query string or fragment", () => {
    const sent = browserReportOf(errorWith(V8_STACK), { errorId: "ANC-K3M2-P7QR", code: "UNKNOWN" }, "/app/prices?price=12.50#top");

    expect(sent.route).toBe("/app/prices");
  });

  it("sends the error's class and an allowed code, and nothing for an error that came from the server", () => {
    // React Router hands the browser a server render's error with its stack emptied.
    const fromServer = new Error("Unexpected Server Error");
    fromServer.stack = "";
    const sent = browserReportOf(fromServer, { errorId: "ANC-K3M2-P7QR", code: "not a code" }, "/app");

    expect(sent).toEqual({ errorId: "ANC-K3M2-P7QR", code: "UNKNOWN", route: "/app", name: "Error", stack: null });
  });

  it("is bounded however deep the stack", () => {
    const deep = Array.from({ length: 500 }, (_, i) => `    at frame${i} (https://anchor.example/a.js:1:${i})`).join("\n");
    const frames = framesOf(deep) ?? "";

    expect(frames.split("\n").length).toBeLessThanOrEqual(MAX_FRAMES);
    expect(frames.length).toBeLessThanOrEqual(MAX_STACK_CHARS);
    expect(frames).toContain("at frame0 ");
  });
});

describe("what the endpoint reads back", () => {
  it("accepts exactly what the boundary sends", () => {
    const sent = browserReportOf(errorWith(V8_STACK), { errorId: newErrorId(), code: "SHOPIFY_UNAVAILABLE" }, "/app");

    expect(browserReportFrom(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  });

  it.each([
    ["a character outside the alphabet", "ANC-OOOO-0000"],
    ["something that is not an id", "drop table"],
    ["an empty one", ""],
    ["one far too long", `ANC-${"A".repeat(400)}`],
    ["a number", 42],
    ["nothing", undefined],
  ])("refuses a reference that is %s", (_why, errorId) => {
    expect(browserReportFrom({ ...report(), errorId })).toBeNull();
  });

  it("refuses a body that is not an object", () => {
    expect(browserReportFrom(null)).toBeNull();
    expect(browserReportFrom("ANC-K3M2-P7QR")).toBeNull();
  });

  it("stores a lower-case reference the way Diagnostics will look it up", () => {
    const read = browserReportFrom({ ...report(), errorId: " anc-k3m2-p7qr " });

    expect(read?.errorId).toBe("ANC-K3M2-P7QR");
    expect(isErrorId(read?.errorId ?? "")).toBe(true);
  });

  it("narrows what it does not refuse: code, name, route and stack", () => {
    const read = browserReportFrom({
      ...report(),
      code: "DROP TABLE",
      name: "TypeError: with a message after it",
      route: "https://elsewhere.example/app",
      stack: `Error: 19.99\n${"    at x (https://a/b.js:1:2)\n".repeat(200)}`,
    });

    expect(read?.code).toBe("UNKNOWN");
    expect(read?.name).toBeNull();
    expect(read?.route).toBeNull();
    expect(read?.stack).not.toContain("19.99");
    expect(read?.stack?.split("\n").length).toBe(MAX_FRAMES);
  });

  it("has nowhere to put a shop, whatever the body says", () => {
    const read = browserReportFrom({ ...report(), shop: "other.myshopify.com", shopId: "someone-else" });

    expect(Object.keys(read ?? {}).sort()).toEqual(["code", "errorId", "name", "route", "stack"]);
  });
});

describe("whether the screen may say the reference is recorded", () => {
  const answering = (status: number, body: string, contentType = "application/json") =>
    vi.fn(async () => new Response(body, { status, headers: { "Content-Type": contentType } }));

  it("posts the report as JSON to the endpoint", async () => {
    const send = answering(200, JSON.stringify({ stored: true }));
    const sent = report();

    await postBrowserReport(sent, send);

    const [path, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(BROWSER_REPORT_PATH);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(sent);
  });

  it("is recorded on the server's word that it stored it", async () => {
    expect(await postBrowserReport(report(), answering(200, JSON.stringify({ stored: true })))).toBe("recorded");
  });

  it.each([
    ["the server refused it", answering(400, JSON.stringify({ stored: false }))],
    ["the server failed", answering(503, "Service Unavailable", "text/plain")],
    ["the server answered without storing", answering(200, JSON.stringify({ stored: false }))],
    // An expired session is redirected to the login page: a 200, in HTML.
    ["the answer was a login page", answering(200, "<!doctype html><html></html>", "text/html")],
    ["the request never left", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")))],
  ])("is unrecorded when %s", async (_why, send) => {
    expect(await postBrowserReport(report(), send as unknown as typeof fetch)).toBe("unrecorded");
  });
});

describe("how often one page sends", () => {
  it("sends a reference once, and every later ask gets the same answer", async () => {
    const send = vi.fn(async () => "recorded" as const);
    const sendOnce = onceEach(send);
    const sent = report();

    const answers = await Promise.all([sendOnce(sent), sendOnce(sent), sendOnce({ ...sent })]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(answers).toEqual(["recorded", "recorded", "recorded"]);
  });

  it("stops sending new references past the page's limit, and says they are unrecorded", async () => {
    const send = vi.fn(async () => "recorded" as const);
    const sendOnce = onceEach(send, 3);

    const answers = [];
    for (let i = 0; i < 10; i++) answers.push(await sendOnce(report()));

    expect(send).toHaveBeenCalledTimes(3);
    expect(answers.filter((answer) => answer === "unrecorded")).toHaveLength(7);
  });
});
