/**
 * The error screen promises only what is true of its reference (#783).
 *
 * "This reference links straight to the full technical detail" was shown under every
 * reference, including the ones minted for a crash in the browser and never stored: the
 * merchant quoted ANC-KFTN-QS6Q, and Diagnostics answered "No error stored". The promise is
 * now made only for a reference the server has, and the boundary renders a browser crash
 * as `recording` until the server says so.
 *
 * Rendered to static markup like the other component tests. That stops at the first
 * paint: the effect that posts the report and moves the screen on does not run here, so
 * what the server answers is covered by `browser-report.test.ts`, and the storing by the
 * `browser-error-report` chaos scenario.
 */

import { renderToStaticMarkup } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  data,
  StaticRouterProvider,
} from "react-router";
import { describe, expect, it } from "vitest";

import { ErrorScreen, REFERENCE_COPY } from "./ErrorScreen";
import { RouteBoundary } from "./RouteBoundary";
import { ANCHOR_ERROR, type ReportedError } from "../lib/errors/report";
import type { ReferenceState } from "../lib/errors/browser-report";
import { sourceOf } from "../lib/testing/source";

const PROMISE = "links straight to the full technical detail";

const screen = (reference?: ReferenceState, errorId: string | null = "ANC-K3M2-P7QR") =>
  renderToStaticMarkup(
    <ErrorScreen
      errorId={errorId}
      userMessage="Something went wrong on our side."
      code="UNKNOWN"
      retryable={false}
      reference={reference}
    />,
  );

/** What a merchant reads, without the markup between the words. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

describe("the sentence under the reference", () => {
  it("promises the technical detail for a reference the server stored", () => {
    expect(words(screen("recorded"))).toContain(PROMISE);
  });

  it("keeps that promise for the server guard's errors, which pass no state at all", () => {
    expect(words(screen(undefined))).toContain(PROMISE);
  });

  it("makes no promise while the report is on its way, and says what support needs", () => {
    const text = words(screen("recording"));

    expect(text).not.toContain(PROMISE);
    expect(text).toContain("what you were doing");
    expect(text).toContain("ANC-K3M2-P7QR");
  });

  it("says the details did not arrive when the report failed, and still gives the reference", () => {
    const text = words(screen("unrecorded"));

    expect(text).not.toContain(PROMISE);
    expect(text).toContain("didn't reach us");
    expect(text).toContain("what you were doing");
    expect(text).toContain("ANC-K3M2-P7QR");
    expect(screen("unrecorded"), "support is no longer one click away").toContain("/app/support?error=ANC-K3M2-P7QR");
  });

  it("is one of three sentences, and only one of them makes the promise", () => {
    const promising = Object.entries(REFERENCE_COPY).filter(([, copy]) => copy.includes(PROMISE));

    expect(promising.map(([state]) => state)).toEqual(["recorded"]);
  });

  it("is not shown at all for a refusal with no reference (#741)", () => {
    const text = words(screen("recorded", null));

    for (const copy of Object.values(REFERENCE_COPY)) expect(text).not.toContain(copy.slice(0, 30));
  });
});

describe("Diagnostics, when a quoted reference is not there", () => {
  // The other end of the same promise. It used to give one reason, a database outage,
  // and sent the reader looking for one when the reference was a browser crash whose
  // report never arrived. A source check because the banner sits behind a loader.
  const banner = sourceOf("app/routes/app.settings.diagnostics.tsx")
    .match(/No error stored under[\s\S]*?<\/s-paragraph>/)?.[0]
    .replace(/\s+/g, " ") ?? "";

  it("names the browser report that never arrived", () => {
    expect(banner).toMatch(/happened in the browser and its report never reached us/);
  });

  it("still names the database, and the age past which a reference is deleted", () => {
    expect(banner).toMatch(/database was down/);
    expect(banner).toMatch(/\{keptForDays\} days old/);
  });

  it("ends with what to do next", () => {
    expect(banner).toMatch(/Send support the reference with what you were doing/);
  });
});

/** Renders the boundary as the router does when the page's loader throws `thrown`. */
async function boundaryFor(thrown: unknown): Promise<string> {
  const routes = [
    {
      id: "page",
      path: "/app/campaigns/c1",
      loader: () => {
        throw thrown;
      },
      Component: () => null,
      ErrorBoundary: RouteBoundary,
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("https://anchor.example/app/campaigns/c1"));
  if (context instanceof Response) throw new Error("the static handler answered with a Response");
  const router = createStaticRouter(handler.dataRoutes, context);
  return words(renderToStaticMarkup(<StaticRouterProvider router={router} context={context} hydrate={false} />));
}

describe("the boundary", () => {
  it("renders an error it reported itself as not yet recorded", async () => {
    // A plain Error reaches the boundary the way a render crash in the browser does: with
    // nothing from the server guard on it. Its reference is the browser's, and until the
    // server says it stored the report, the screen must not promise the detail.
    const text = await boundaryFor(new TypeError("Cannot read properties of undefined (reading 'map')"));

    expect(text).toMatch(/ANC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/);
    expect(text).not.toContain(PROMISE);
    expect(text).toContain(REFERENCE_COPY.recording.slice(0, 40));
  });

  it("renders the server guard's error as recorded, since the guard stored it", async () => {
    const reported: ReportedError = {
      errorId: "ANC-K3M2-P7QR",
      code: "NOT_FOUND",
      userMessage: "That campaign or record no longer exists.",
      retryable: false,
      status: 404,
    };
    const text = await boundaryFor(data({ [ANCHOR_ERROR]: reported }, { status: 404 }));

    expect(text).toContain("ANC-K3M2-P7QR");
    expect(text).toContain(PROMISE);
  });
});
