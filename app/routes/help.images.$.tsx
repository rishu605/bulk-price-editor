/**
 * Screenshots and diagrams belonging to help pages.
 *
 * A separate route from `help.$` rather than a branch inside it: that loader returns data
 * for a React component, and a route that sometimes returns raw bytes instead has a
 * return type nothing downstream can use honestly. React Router matches the more specific
 * path first, so `/help/images/…` lands here and everything else stays a page.
 *
 * Unauthenticated, like the pages, and reading a caller-supplied path — so it goes through
 * the same containment checks, with the alphabet widened only by a file extension from a
 * fixed list.
 */

import type { LoaderFunctionArgs } from "react-router";

import { readHelpImage } from "../lib/help/pages.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const image = await readHelpImage(`images/${params["*"] ?? ""}`);

  if (!image) {
    // A plain 404 rather than the help centre's error page: a browser asking for an image
    // wants a status, not prose.
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(image.body), {
    headers: {
      "Content-Type": image.contentType,
      // Screenshots change only when a deploy changes them, and a stale one for an hour
      // is a smaller problem than re-fetching them on every page view.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
