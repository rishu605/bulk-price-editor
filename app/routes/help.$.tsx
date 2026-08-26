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
import { searchHelp, type HelpHit } from "../lib/help/search.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const slug = params["*"] || INDEX_SLUG;

  // Search is a GET with a query string rather than a route of its own, so a merchant can
  // bookmark or share a result list, and so the back button behaves.
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query) {
    return { query, hits: searchHelp(query), page: null, isIndex: false };
  }

  const page = await readHelpPage(slug);

  // A 404 rather than a redirect to the index: the merchant followed a specific link, and
  // silently landing them somewhere else hides that a link in the product is wrong.
  if (!page) throw data({ slug }, { status: 404 });

  return { query, hits: null, page, isIndex: slug === INDEX_SLUG };
}

export function meta({ data: loaded }: { data?: Awaited<ReturnType<typeof loader>> }) {
  const SUFFIX = "Anchor help";
  const title = loaded?.query ? `${loaded.query} — search` : (loaded?.page?.title ?? SUFFIX);

  // The index's own heading is already the suffix, and "Anchor help · Anchor help" in a
  // browser tab reads like a bug because it is one.
  return [{ title: title === SUFFIX ? title : `${title} · ${SUFFIX}` }];
}

export default function HelpRoute() {
  const { page, isIndex, query, hits } = useLoaderData<typeof loader>();

  if (hits) {
    return (
      <Shell showBack query={query}>
        <h1>
          {hits.length === 0 ? "Nothing matched" : `${hits.length} page${hits.length === 1 ? "" : "s"}`}
          {" for "}
          {/* Rendered as text, never as markup: this is the only thing on the page that
              did not come from a file we wrote. */}
          <em>{query}</em>
        </h1>
        {hits.length === 0 ? (
          <p>
            Try a single word — the pages are written in plain language, so the word you
            would say out loud is usually the one that finds them.
          </p>
        ) : (
          <ol className="hits">
            {hits.map((hit) => (
              <li key={hit.slug}>
                <a href={`/help/${hit.slug}`}>{hit.title}</a>
                <p>{highlight(hit)}</p>
              </li>
            ))}
          </ol>
        )}
      </Shell>
    );
  }

  return (
    <Shell showBack={!isIndex} query={query}>
      {/* The markdown is committed alongside this file — it is our prose, not input. */}
      <article dangerouslySetInnerHTML={{ __html: page!.html }} />
    </Shell>
  );
}

/** The matched term marked inside its snippet, split into nodes so React does the escaping. */
function highlight(hit: HelpHit) {
  if (!hit.match) return hit.snippet;

  return (
    <>
      {hit.snippet.slice(0, hit.match.start)}
      <mark>{hit.snippet.slice(hit.match.start, hit.match.end)}</mark>
      {hit.snippet.slice(hit.match.end)}
    </>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;

  return (
    <Shell showBack query="">
      <h1>{missing ? "No such help page" : "That page could not be loaded"}</h1>
      <p>
        {missing
          ? "The link that brought you here points at a page that does not exist. That is our mistake, not yours — everything we have written is one click away."
          : "Something went wrong reading this page."}
      </p>
    </Shell>
  );
}

function Shell({
  children,
  showBack,
  query,
}: {
  children: React.ReactNode;
  showBack: boolean;
  query: string;
}) {
  return (
    <main className="help">
      <style>{STYLES}</style>
      <nav>
        {showBack ? <a href="/help">← Help centre</a> : <span />}
        {/* A plain GET form: it works before any JavaScript has loaded, which matters on
            a page a merchant may reach while the rest of the app is misbehaving. */}
        <form method="get" action="/help" role="search">
          <label htmlFor="q" className="visually-hidden">
            Search the help centre
          </label>
          <input id="q" type="search" name="q" defaultValue={query} placeholder="Search help" />
          <button type="submit">Search</button>
        </form>
      </nav>
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
.help nav {
  margin-bottom: 2rem;
  font-size: 0.875rem;
  display: flex;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
}
.help nav form { display: flex; gap: 0.5rem; }
.help input[type="search"], .help button {
  font: inherit;
  padding: 0.35rem 0.6rem;
  border: 1px solid #8e8e8e;
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
.help button { cursor: pointer; }
.help mark { background: #ffe9a8; color: inherit; }
.help ol.hits { list-style: none; padding: 0; }
.help ol.hits li { margin: 0 0 1.5rem; }
.help ol.hits p { margin: 0.25rem 0 0; color: #4a4a4a; }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
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
  .help ol.hits p { color: #b5b5b5; }
  .help mark { background: #6b5510; color: #f5f5f5; }
  .help input[type="search"], .help button { border-color: #707070; }
}
`;
