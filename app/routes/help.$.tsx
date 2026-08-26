/**
 * The help centre, served from the app.
 *
 * Every merchant-visible error carries a link built by `helpUrlFor`, and until this route
 * existed those links pointed at a domain nobody had registered. A dead link on an error
 * screen is worse than no link at all — it confirms the merchant's suspicion that nobody
 * is looking after this — so the docs in `docs/help` are now published from the same
 * deploy that references them, which is also what stops the two drifting apart.
 *
 * Unauthenticated on purpose. A merchant may arrive here from an email, from a session
 * that has already expired, or from a browser that is not inside the Shopify admin, and
 * the pages contain no shop data — only prose about how the app behaves. Because it is
 * public and takes a path from the URL, `resolveHelpFile` is the security boundary; the
 * reasoning is in the note there.
 *
 * The caveat worth stating plainly: `failures/app-unavailable` is served by the app it
 * describes, so it is missing exactly when it is wanted. `HELP_BASE_URL` overrides the
 * base so the docs can move to independent hosting without touching any call site.
 */

import type { LoaderFunctionArgs } from "react-router";
import { data, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";

import { INDEX_SLUG, readHelpPage } from "../lib/help/pages.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const slug = params["*"] || INDEX_SLUG;

  const page = await readHelpPage(slug);

  // A 404 rather than a redirect to the index: the merchant followed a specific link, and
  // silently landing them somewhere else hides that a link in the product is wrong.
  if (!page) throw data({ slug }, { status: 404 });

  return { page, isIndex: slug === INDEX_SLUG };
}

export function meta({ data: loaded }: { data?: Awaited<ReturnType<typeof loader>> }) {
  const SUFFIX = "Anchor help";
  const title = loaded?.page.title ?? SUFFIX;

  // The index's own heading is already the suffix, and "Anchor help · Anchor help" in a
  // browser tab reads like a bug because it is one.
  return [{ title: title === SUFFIX ? title : `${title} · ${SUFFIX}` }];
}

export default function HelpRoute() {
  const { page, isIndex } = useLoaderData<typeof loader>();

  return (
    <Shell showBack={!isIndex}>
      {/* The markdown is committed alongside this file — it is our prose, not input. */}
      <article dangerouslySetInnerHTML={{ __html: page.html }} />
    </Shell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;

  return (
    <Shell showBack>
      <h1>{missing ? "No such help page" : "That page could not be loaded"}</h1>
      <p>
        {missing
          ? "The link that brought you here points at a page that does not exist. That is our mistake, not yours — everything we have written is one click away."
          : "Something went wrong reading this page."}
      </p>
    </Shell>
  );
}

function Shell({ children, showBack }: { children: React.ReactNode; showBack: boolean }) {
  return (
    <main className="help">
      <style>{STYLES}</style>
      {showBack ? (
        <nav>
          <a href="/help">← Help centre</a>
        </nav>
      ) : null}
      {children}
    </main>
  );
}

/**
 * Inline rather than imported: this route is the one a merchant reaches when something
 * else has already gone wrong, and one fewer asset to fetch is one fewer thing to fail.
 */
const STYLES = `
.help {
  max-width: 42rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 6rem;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.65;
  color: #1a1a1a;
}
.help nav { margin-bottom: 2rem; font-size: 0.875rem; }
.help a { color: #005bd3; }
.help h1 { font-size: 1.75rem; line-height: 1.3; margin: 0 0 1rem; }
.help h2 { font-size: 1.25rem; margin: 2.5rem 0 0.75rem; }
.help h3 { font-size: 1.0625rem; margin: 2rem 0 0.5rem; }
.help ul, .help ol { padding-left: 1.5rem; }
.help li { margin: 0.35rem 0; }
.help code {
  font-size: 0.875em;
  background: #f1f1f1;
  padding: 0.1em 0.35em;
  border-radius: 3px;
}
.help pre { background: #f1f1f1; padding: 1rem; border-radius: 6px; overflow-x: auto; }
.help pre code { background: none; padding: 0; }
.help table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
.help th, .help td {
  border: 1px solid #e1e1e1;
  padding: 0.5rem 0.75rem;
  text-align: left;
  vertical-align: top;
}
.help blockquote {
  margin: 1.25rem 0;
  padding-left: 1rem;
  border-left: 3px solid #e1e1e1;
  color: #4a4a4a;
}
@media (prefers-color-scheme: dark) {
  body { background: #1a1a1a; }
  .help { color: #e3e3e3; }
  .help a { color: #6aa9ff; }
  .help code, .help pre { background: #2a2a2a; }
  .help th, .help td { border-color: #3a3a3a; }
  .help blockquote { border-left-color: #3a3a3a; color: #b5b5b5; }
}
`;
