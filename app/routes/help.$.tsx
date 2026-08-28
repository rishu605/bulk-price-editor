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
 * **What this route adds to the markdown.** The docs are a curated set, not a folder, and
 * the first version of this page threw that away: `index.md` was rendered as markdown and
 * arrived as thirty underlined blue links in three bulleted lists, with no way to tell a
 * concept from an emergency. So the index is parsed into a structure (`nav.server.ts`)
 * and rendered — as a landing page, as the sidebar on every page, as the breadcrumb, and
 * as the next/previous links at the foot of each one. All four come from the one file a
 * writer already maintains, so none of them can go stale on their own.
 *
 * The caveat worth stating plainly: `failures/app-unavailable` is served by the app it
 * describes, so it is missing exactly when it is wanted. `HELP_BASE_URL` overrides the
 * base so the docs can move to independent hosting without touching any call site.
 */

import type { LoaderFunctionArgs } from "react-router";
import { data, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";

import {
  placeInNav,
  sectionTitleOf,
  startingPoints,
  toneOf,
  TONES,
  type HelpNav,
  type HelpNavItem,
  type HelpPlace,
} from "../lib/help/nav";
import { helpNav } from "../lib/help/nav.server";
import { INDEX_SLUG, readHelpPage, type HelpPage } from "../lib/help/pages.server";
import { searchHelp, type HelpHit } from "../lib/help/search.server";
import { HelpStyles } from "../lib/help/styles";

/** A result carries the section it came from, so a reader can tell a concept from a crisis. */
type SearchResult = HelpHit & { section: string | null };

export async function loader({ params, request }: LoaderFunctionArgs) {
  const slug = params["*"] || INDEX_SLUG;
  const nav = helpNav();

  // Search is a GET with a query string rather than a route of its own, so a merchant can
  // bookmark or share a result list, and so the back button behaves.
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query) {
    const hits: SearchResult[] = searchHelp(query).map((hit) => ({
      ...hit,
      section: sectionTitleOf(nav, hit.slug),
    }));

    return { view: "search" as const, query, hits, nav, page: null, place: null, tone: null };
  }

  if (slug === INDEX_SLUG) {
    return { view: "index" as const, query, hits: null, nav, page: null, place: null, tone: null };
  }

  const page = await readHelpPage(slug);

  // A 404 rather than a redirect to the index: the merchant followed a specific link, and
  // silently landing them somewhere else hides that a link in the product is wrong.
  if (!page) throw data({ slug }, { status: 404 });

  const place = placeInNav(nav, slug);

  return {
    view: "page" as const,
    query,
    hits: null,
    nav,
    page,
    place,
    tone: place ? toneOf(nav, place.section) : null,
  };
}

export function meta({ data: loaded }: { data?: Awaited<ReturnType<typeof loader>> }) {
  const SUFFIX = "Anchor help";
  const title = loaded?.query ? `${loaded.query} — search` : (loaded?.page?.title ?? SUFFIX);

  // The index's own heading is already the suffix, and "Anchor help · Anchor help" in a
  // browser tab reads like a bug because it is one.
  return [{ title: title === SUFFIX ? title : `${title} · ${SUFFIX}` }];
}

export default function HelpRoute() {
  const loaded = useLoaderData<typeof loader>();

  if (loaded.view === "search") {
    return (
      <Shell query={loaded.query}>
        <Results query={loaded.query} hits={loaded.hits} nav={loaded.nav} />
      </Shell>
    );
  }

  if (loaded.view === "index") {
    return (
      <Shell query="">
        <Landing nav={loaded.nav} />
      </Shell>
    );
  }

  return (
    <Shell query={loaded.query}>
      <Document nav={loaded.nav} page={loaded.page} place={loaded.place} tone={loaded.tone} />
    </Shell>
  );
}

/* -- the landing page ------------------------------------------------------ */

function Landing({ nav }: { nav: HelpNav }) {
  return (
    <main id="content">
      <div className="hero bar">
        <div className="hero-inner">
          <p className="eyebrow">Help centre</p>
          <h1>{nav.title}</h1>
          {nav.lede ? <p className="lede">{nav.lede}</p> : null}
          <SearchForm query="" size="lg" />
          <StartHere nav={nav} />
        </div>
      </div>

      <div className="bar">
        {nav.sections.map((section, index) => (
          <section className="group" key={section.id} data-tone={index % TONES}>
            <div className="group-head">
              <h2 id={section.id}>{section.title}</h2>
              {section.blurb ? <p>{section.blurb}</p> : null}
            </div>
            <CardList items={section.items} />
          </section>
        ))}
      </div>
    </main>
  );
}

/**
 * The first page of each section, as a sentence.
 *
 * Somebody who has just installed the app is not browsing — they have a question and are
 * deciding whether this page is worth their next thirty seconds. Three named destinations
 * answer that faster than a heading called "Concepts" does.
 */
function StartHere({ nav }: { nav: HelpNav }) {
  const starts = startingPoints(nav);
  if (starts.length === 0) return null;

  return (
    <p className="jump">
      Start with{" "}
      {starts.map((item, index) => (
        <span key={item.slug}>
          {index > 0 ? (index === starts.length - 1 ? " or " : ", ") : ""}
          <a href={`/help/${item.slug}`}>{lowerFirst(item.title)}</a>
        </span>
      ))}
      .
    </p>
  );
}

/**
 * Cards, or a list once there are too many for cards to stay scannable.
 *
 * Ten failure pages as ten cards is a wall, and the section a merchant reaches during an
 * incident is the last one that should need reading twice. The threshold is on the count
 * rather than on the section's name, so it holds for whatever the index says tomorrow.
 */
function CardList({ items }: { items: HelpNavItem[] }) {
  const dense = items.length > 6;

  return (
    <ul className={dense ? "cards cards-dense" : "cards"}>
      {items.map((item) => (
        <li key={item.slug}>
          <a className="card" href={`/help/${item.slug}`}>
            <span className="card-title">{item.title}</span>
            {item.blurb && !dense ? <span className="card-blurb">{item.blurb}</span> : null}
          </a>
        </li>
      ))}
    </ul>
  );
}

/* -- a page ---------------------------------------------------------------- */

function Document({
  nav,
  page,
  place,
  tone,
}: {
  nav: HelpNav;
  page: HelpPage;
  place: HelpPlace | null;
  tone: number | null;
}) {
  return (
    <div className="layout bar" data-tone={tone ?? undefined}>
      <Rail nav={nav} here={place ? { slug: page.slug, section: place.section.id } : null} />

      <main id="content" className="doc">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="/help">Help centre</a>
          {place ? (
            <>
              <span className="sep" aria-hidden="true">/</span>
              <a href={`/help#${place.section.id}`}>{place.section.title}</a>
            </>
          ) : null}
        </nav>

        {/* The markdown is committed alongside this file — it is our prose, not input. */}
        <article dangerouslySetInnerHTML={{ __html: page.html }} />

        {page.related.length > 0 ? (
          <section className="onward">
            <h2>Related</h2>
            <div className="pager">
              {page.related.map((link) => (
                <a className="step" key={link.href} href={link.href}>
                  <span className="step-title">{link.label}</span>
                </a>
              ))}
            </div>
          </section>
        ) : null}

        {place && (place.previous || place.next) ? (
          <section className="onward">
            <h2>{place.section.title}</h2>
            <div className="pager">
              {place.previous ? (
                <a className="step" href={`/help/${place.previous.slug}`}>
                  <span className="step-kind">← Previous</span>
                  <span className="step-title">{place.previous.title}</span>
                </a>
              ) : (
                <span />
              )}
              {place.next ? (
                <a className="step step-next" href={`/help/${place.next.slug}`}>
                  <span className="step-kind">Next →</span>
                  <span className="step-title">{place.next.title}</span>
                </a>
              ) : null}
            </div>
          </section>
        ) : null}
      </main>

      <Contents page={page} />
    </div>
  );
}

/**
 * Every page in the centre, with the current one marked.
 *
 * `here` names a section as well as a slug because one page is listed twice — guardrails
 * are both a concept and a thing that stops a run — and marking both entries would tell a
 * reader they are in two places at once.
 */
function Rail({ nav, here }: { nav: HelpNav; here: { slug: string; section: string } | null }) {
  return (
    <div className="rail">
      {nav.sections.map((section, index) => (
        <nav key={section.id} aria-label={section.title} data-tone={index % TONES}>
          <p className="rail-head">{section.title}</p>
          <ul>
            {section.items.map((item) => {
              const current = here?.section === section.id && here.slug === item.slug;
              return (
                <li key={item.slug}>
                  <a href={`/help/${item.slug}`} aria-current={current ? "page" : undefined}>
                    {item.title}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      ))}
    </div>
  );
}

function Contents({ page }: { page: HelpPage }) {
  // One heading is not a contents list, it is the page. Two is where it starts to help.
  if (page.headings.length < 2) return null;

  return (
    <nav className="toc" aria-label="On this page">
      <p className="toc-head">On this page</p>
      <ol>
        {page.headings.map((heading) => (
          <li key={heading.id}>
            <a href={`#${heading.id}`}>{heading.text}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/* -- search ---------------------------------------------------------------- */

function Results({ query, hits, nav }: { query: string; hits: SearchResult[]; nav: HelpNav }) {
  return (
    <main id="content" className="results bar">
      <h1>
        {hits.length === 0 ? "Nothing matched" : `${hits.length} page${hits.length === 1 ? "" : "s"}`}
        {" for "}
        {/* Rendered as text, never as markup: this is the only thing on the page that
            did not come from a file we wrote. */}
        <em>{query}</em>
      </h1>

      {hits.length === 0 ? (
        <>
          <p className="lede">
            Try a single word — the pages are written in plain language, so the word you
            would say out loud is usually the one that finds them.
          </p>
          <CardList items={startingPoints(nav)} />
        </>
      ) : (
        <ol className="hits">
          {hits.map((hit) => (
            <li key={hit.slug}>
              <a className="hit" href={`/help/${hit.slug}`}>
                {hit.section ? <span className="hit-kind">{hit.section}</span> : null}
                <span className="hit-title">{hit.title}</span>
                <p className="hit-snippet">{highlight(hit)}</p>
              </a>
            </li>
          ))}
        </ol>
      )}
    </main>
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
    <Shell query="">
      <main id="content" className="results bar">
        <p className="eyebrow">{missing ? "404" : "Error"}</p>
        <h1>{missing ? "No such help page" : "That page could not be loaded"}</h1>
        <p className="lede">
          {missing
            ? "The link that brought you here points at a page that does not exist. That is our mistake, not yours — everything we have written is one click away."
            : "Something went wrong reading this page. Everything we have written is still one click away."}
        </p>
        <p className="jump">
          <a href="/help">Go to the help centre →</a>
        </p>
      </main>
    </Shell>
  );
}

/* -- shell ----------------------------------------------------------------- */

function Shell({ children, query }: { children: React.ReactNode; query: string }) {
  return (
    <div className="help">
      <HelpStyles />

      <a className="skip" href="#content">
        Skip to content
      </a>

      <header className="masthead">
        <div className="bar">
          <a className="brand" href="/help">
            <AnchorMark />
            <span>Anchor</span>
            <span className="brand-sep" aria-hidden="true">
              /
            </span>
            <span className="brand-kind">Help centre</span>
          </a>
          <SearchForm query={query} size="sm" />
        </div>
      </header>

      {children}

      <footer className="colophon">
        <div className="bar">
          <p>
            Anchor manages price campaigns for Shopify stores selling into more than one
            market. These pages ship with the app, so what they describe is what your store
            is running.
          </p>
          <p>
            <a href="/help">Help centre</a>
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * A plain GET form: it works before any JavaScript has loaded, which matters on a page a
 * merchant may reach while the rest of the app is misbehaving.
 */
function SearchForm({ query, size }: { query: string; size: "sm" | "lg" }) {
  const id = `q-${size}`;

  return (
    <form method="get" action="/help" role="search" className={size === "lg" ? "find find-lg" : "find"}>
      <label htmlFor={id} className="visually-hidden">
        Search the help centre
      </label>
      <span className="field">
        <SearchMark />
        <input
          id={id}
          type="search"
          name="q"
          defaultValue={query}
          placeholder={size === "lg" ? "Search every page" : "Search help"}
        />
      </span>
      <button type="submit">Search</button>
    </form>
  );
}

function lowerFirst(text: string): string {
  // "What a baseline is" reads as part of the sentence; "WIP" and "Anchor" must not be
  // flattened, so only a word that is otherwise lowercase is touched.
  const [first, rest] = [text.slice(0, 1), text.slice(1)];
  return rest === rest.toLowerCase() ? first.toLowerCase() + rest : text;
}

function AnchorMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 7.4V21M7 11h10M21 15a9 9 0 0 1-18 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
