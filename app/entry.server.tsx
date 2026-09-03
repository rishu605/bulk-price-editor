import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { initSentry } from "./lib/observability/sentry.server";
import { initOtel } from "./lib/observability/otel.server";
import { logger } from "./lib/logging/logger";

// Once per process, at import time, before any request is handled. Initialising lazily
// on the first error would miss the errors that happen during startup, which are the ones
// most likely to be about configuration.
initSentry({ process: "web" });
// Not awaited: the SDK starts in the background and metrics recorded before it is ready
// fall through to the log sink, which is where they were going anyway.
void initOtel({ process: "web" });

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          // Through the logger, not `console.error(error)`. This prints a render
          // failure's message and stack, and a render below a loader that touched a
          // price is exactly where one appears — stdout ships to the aggregator, so it
          // goes through the same two passes as every other line.
          logger.error("render failed", { route: new URL(request.url).pathname, error });
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
