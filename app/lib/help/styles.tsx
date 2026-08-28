/**
 * The help centre's stylesheet.
 *
 * Inlined into the document by the route rather than linked, and that is the whole reason
 * it is a string in a module instead of a `.css` file: this is the page a merchant reaches
 * when something else has already gone wrong, and one fewer asset to fetch is one fewer
 * thing to fail. It is authored here rather than in the route so that neither file has to
 * be scrolled past to read the other.
 *
 * Every colour is a custom property declared twice — once on `.help`, once under the dark
 * media query — and nothing anywhere else in the sheet names a colour directly. That is
 * not tidiness: `help-contrast.test.ts` resolves these two blocks and computes WCAG ratios
 * from them, so a palette can only be changed in a place the test is looking. A hard-coded
 * hex further down the sheet would be invisible to it.
 *
 * `data-tone` on a section picks one of three accents by position in the index, so adding
 * a fourth section to `docs/help/index.md` needs no change here.
 */
export const HELP_STYLES = `
:root {
  --paper: #ffffff;
  --surface: #f6f7f9;
  --raised: #ffffff;
  --ink: #1a1f24;
  --muted: #5b656f;
  --hairline: #e4e7ea;
  --control-border: #7e878f;
  --accent: #2748c4;
  --accent-wash: #eef1fd;
  --mark: #ffe9a8;
  --mark-ink: #1a1f24;
  --figure: #f6f7f9;
  --tone-0: #3a4ea8;
  --tone-1: #0d6a4f;
  --tone-2: #8a4a10;
  --lift: 0 1px 1px rgba(16, 24, 32, 0.04), 0 10px 24px -18px rgba(16, 24, 32, 0.5);
  --lift-hover: 0 1px 2px rgba(16, 24, 32, 0.06), 0 16px 32px -18px rgba(16, 24, 32, 0.55);

  --measure: 40rem;
  --gutter: clamp(1.25rem, 4vw, 2.5rem);
  --radius: 12px;
}
body { margin: 0; background: var(--paper); }
.help {
  color: var(--ink);
  background: var(--paper);
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.help *, .help *::before, .help *::after { box-sizing: border-box; }
.help :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.help a { color: var(--accent); }
.help [data-tone="0"] { --tone: var(--tone-0); }
.help [data-tone="1"] { --tone: var(--tone-1); }
.help [data-tone="2"] { --tone: var(--tone-2); }

/* ---- shell ------------------------------------------------------------- */

/* The explicit width is load-bearing. This element is a child of a column flex container,
   and a flex child with auto side margins is sized by its content rather than stretched —
   which centred the search results in a column half the width of the landing page. */
.help .bar {
  width: 100%;
  max-width: 76rem;
  margin: 0 auto;
  padding: 0 var(--gutter);
}
.help .skip {
  position: absolute;
  left: -9999px;
  top: 0.5rem;
  padding: 0.5rem 0.9rem;
  background: var(--raised);
  border: 1px solid var(--control-border);
  border-radius: 8px;
  z-index: 2;
}
.help .skip:focus { left: 1rem; }

.help .masthead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  backdrop-filter: saturate(1.6) blur(10px);
  border-bottom: 1px solid var(--hairline);
}
.help .masthead .bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 3.5rem;
}
.help .brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--ink);
  text-decoration: none;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.help .brand svg { display: block; color: var(--accent); }
.help .brand-sep { color: var(--hairline); font-weight: 400; }
.help .brand-kind { color: var(--muted); font-weight: 450; }
.help .brand:hover .brand-kind { color: var(--ink); }

/* ---- search ------------------------------------------------------------ */

.help .find { display: flex; align-items: center; gap: 0.5rem; }
.help .field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  padding: 0 0.7rem;
  background: var(--raised);
  border: 1px solid var(--control-border);
  border-radius: 999px;
  transition: box-shadow 120ms ease, border-color 120ms ease;
}
.help .field:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-wash);
}
.help .field svg { flex: none; color: var(--muted); }
.help .find input {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  outline: 0;
  padding: 0.45rem 0;
  width: 12rem;
  min-width: 0;
}
.help .find input::placeholder { color: var(--muted); }
.help .find button {
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  padding: 0.45rem 1rem;
  color: var(--paper);
  background: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 999px;
  white-space: nowrap;
}
.help .find button:hover { background: var(--accent); border-color: var(--accent); }
.help .find-lg { max-width: 34rem; margin-top: 2rem; }
.help .find-lg input { width: 100%; font-size: 1.0625rem; padding: 0.7rem 0; }
.help .find-lg .field { padding: 0 1rem; }
.help .find-lg button { padding: 0.7rem 1.4rem; }

/* ---- landing ----------------------------------------------------------- */

.help main { flex: 1; }
.help .hero { padding-block: clamp(3rem, 8vw, 5.5rem) clamp(2.5rem, 5vw, 3.5rem); }
.help .hero-inner { max-width: 46rem; }
.help .eyebrow {
  margin: 0 0 0.75rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tone, var(--muted));
}
.help .hero h1 {
  margin: 0;
  font-size: clamp(2.25rem, 5.5vw, 3.25rem);
  line-height: 1.08;
  letter-spacing: -0.03em;
  font-weight: 640;
}
.help .lede {
  margin: 1.25rem 0 0;
  font-size: clamp(1.0625rem, 1.4vw, 1.1875rem);
  line-height: 1.6;
  color: var(--muted);
}
.help .jump { margin: 1rem 0 0; font-size: 0.9375rem; color: var(--muted); }
.help .jump a {
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
.help .jump a:hover { text-decoration-color: currentColor; }

.help .group { padding-bottom: clamp(2.5rem, 5vw, 3.5rem); }
.help .group + .group { border-top: 1px solid var(--hairline); padding-top: clamp(2.5rem, 5vw, 3.25rem); }
.help .group-head { max-width: 42rem; margin-bottom: 1.75rem; }
.help .group-head h2 {
  margin: 0;
  font-size: 1.5rem;
  line-height: 1.25;
  letter-spacing: -0.02em;
  font-weight: 620;
  scroll-margin-top: 5rem;
}
.help .group-head p { margin: 0.5rem 0 0; color: var(--muted); }

.help .cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.875rem;
  grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
}
.help .card {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 0.35rem;
  padding: 1.125rem 1.25rem;
  background: var(--raised);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  text-decoration: none;
  color: inherit;
  box-shadow: var(--lift);
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
}
.help .card::before {
  content: "";
  width: 1.5rem;
  height: 2px;
  border-radius: 2px;
  background: var(--tone, var(--accent));
  margin-bottom: 0.5rem;
  opacity: 0.85;
}
.help .card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--tone, var(--accent)) 40%, var(--hairline));
  box-shadow: var(--lift-hover);
}
.help .card-title { font-weight: 580; letter-spacing: -0.01em; line-height: 1.35; }
.help .card:hover .card-title { color: var(--tone, var(--accent)); }
.help .card-blurb { font-size: 0.9375rem; line-height: 1.5; color: var(--muted); }

/* A section with more entries than a grid of cards can hold without becoming a wall. */
.help .cards-dense { grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 0; }
.help .cards-dense li { border-bottom: 1px solid var(--hairline); }
.help .cards-dense .card {
  flex-direction: row;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.8rem 0.25rem;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: none;
}
.help .cards-dense .card:hover { transform: none; box-shadow: none; }
.help .cards-dense .card::before {
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 50%;
  margin: 0;
  flex: none;
  align-self: center;
  opacity: 0.5;
}
.help .cards-dense .card:hover::before { opacity: 1; }

/* ---- article ----------------------------------------------------------- */

.help .layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: clamp(2rem, 5vw, 3.5rem);
  padding-block: 2.25rem 4rem;
  align-items: start;
}
.help .rail { order: 3; }
.help .doc { order: 1; min-width: 0; max-width: var(--measure); }
.help .toc { order: 2; display: none; }

.help .crumbs {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
  font-size: 0.8125rem;
  color: var(--muted);
}
.help .crumbs a { color: var(--muted); text-decoration: none; }
.help .crumbs a:hover { color: var(--ink); text-decoration: underline; }
.help .crumbs .sep { opacity: 0.5; }
.help .crumbs .here { color: var(--tone, var(--muted)); font-weight: 550; }

.help .rail-head, .help .toc-head {
  margin: 0 0 0.625rem;
  padding-left: 0.6rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.help .rail ul, .help .toc ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.help .rail nav + nav { margin-top: 1.25rem; }
/* No negative margin. A box with overflow-y set to auto scrolls on the x axis too, so
   anything hanging outside it is clipped — which is what hid the current page's marker
   and put a horizontal scrollbar under the list. */
.help .rail a {
  display: block;
  padding: 0.25rem 0.6rem;
  border-radius: 7px;
  font-size: 0.875rem;
  line-height: 1.4;
  color: var(--muted);
  text-decoration: none;
}
.help .rail a:hover { color: var(--ink); background: var(--surface); }
.help .rail a[aria-current="page"] {
  color: var(--tone, var(--accent));
  background: var(--surface);
  font-weight: 550;
  box-shadow: inset 2px 0 0 var(--tone, var(--accent));
}

.help .toc-head { padding-left: calc(0.75rem + 2px); }
.help .toc a {
  display: block;
  padding: 0.2rem 0 0.2rem 0.75rem;
  border-left: 2px solid var(--hairline);
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--muted);
  text-decoration: none;
}
.help .toc a:hover { color: var(--ink); border-left-color: var(--tone, var(--accent)); }

/* ---- prose ------------------------------------------------------------- */

.help article { font-size: 1.0625rem; }
.help article > *:first-child { margin-top: 0; }
.help article a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
.help article a:hover { text-decoration-color: currentColor; }
.help h1 {
  font-size: clamp(1.875rem, 4vw, 2.5rem);
  line-height: 1.12;
  letter-spacing: -0.025em;
  font-weight: 640;
  margin: 0 0 1.25rem;
}
.help article h2 {
  font-size: 1.375rem;
  line-height: 1.3;
  letter-spacing: -0.015em;
  font-weight: 620;
  margin: 2.75rem 0 0.75rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--hairline);
  scroll-margin-top: 5rem;
}
.help article h3 {
  font-size: 1.0625rem;
  font-weight: 620;
  margin: 2rem 0 0.5rem;
  scroll-margin-top: 5rem;
}
.help article p { margin: 0 0 1.125rem; }
.help article ul, .help article ol { padding-left: 1.25rem; margin: 0 0 1.125rem; }
.help article li { margin: 0.4rem 0; }
.help article li::marker { color: var(--muted); }
.help article strong { font-weight: 620; }
.help article hr { border: 0; border-top: 1px solid var(--hairline); margin: 2.5rem 0; }

.help code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.875em;
  background: var(--surface);
  border: 1px solid var(--hairline);
  padding: 0.05em 0.35em;
  border-radius: 5px;
}
.help pre {
  background: var(--surface);
  border: 1px solid var(--hairline);
  padding: 1rem 1.125rem;
  border-radius: var(--radius);
  overflow-x: auto;
  font-size: 0.875rem;
  line-height: 1.6;
}
.help pre code { background: none; border: 0; padding: 0; font-size: 1em; }

/* Screenshots are captured at admin width and are far wider than this column. Scaling
   them down keeps the page from scrolling sideways, which is the one thing a reader
   should never have to do to finish a sentence. */
.help article img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1.75rem 0;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  /* Screenshots are of a light admin and the one diagram is authored in light colours, so
     a dark palette gets a pale mat behind them rather than a bright rectangle floating on
     black. Redrawing every figure for two palettes is the alternative, and it is a
     standing cost on every future screenshot. */
  background: var(--figure);
  padding: 0.25rem;
}

.help .scroller { overflow-x: auto; margin: 0 0 1.5rem; }
.help table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.9375rem;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  overflow: hidden;
}
.help thead { background: var(--surface); }
.help th, .help td {
  border-bottom: 1px solid var(--hairline);
  padding: 0.6rem 0.85rem;
  text-align: left;
  vertical-align: top;
}
.help th { font-weight: 600; }
.help tbody tr:last-child td { border-bottom: 0; }

.help blockquote {
  margin: 1.5rem 0;
  padding: 0.875rem 1.125rem;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-left: 3px solid var(--tone, var(--accent));
  border-radius: 0 var(--radius) var(--radius) 0;
  color: var(--ink);
}
.help blockquote > *:last-child { margin-bottom: 0; }

/* ---- what to read next ------------------------------------------------- */

.help .onward { margin-top: 3.5rem; padding-top: 1.75rem; border-top: 1px solid var(--hairline); }
.help .onward h2 {
  margin: 0 0 1rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.help .pager {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  margin-top: 1.5rem;
}
.help .step {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.9rem 1.125rem;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  text-decoration: none;
  color: inherit;
  background: var(--raised);
}
.help .step:hover { border-color: color-mix(in srgb, var(--tone, var(--accent)) 40%, var(--hairline)); }
.help .step-kind { font-size: 0.75rem; color: var(--muted); }
.help .step-title { font-weight: 550; line-height: 1.35; }
.help .step:hover .step-title { color: var(--tone, var(--accent)); }
.help .step-next { text-align: right; }

/* ---- search results ---------------------------------------------------- */

.help .results { padding-block: 2.5rem 4rem; }
.help .results h1 { margin-bottom: 0.5rem; }
.help .results .lede { margin-bottom: 2rem; max-width: var(--measure); }
.help .hits { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; max-width: 46rem; }
.help .hit {
  display: block;
  padding: 1.125rem 1.25rem;
  background: var(--raised);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  text-decoration: none;
  color: inherit;
  box-shadow: var(--lift);
}
.help .hit:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--hairline)); box-shadow: var(--lift-hover); }
.help .hit-kind {
  display: block;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 0.25rem;
}
.help .hit-title { font-size: 1.0625rem; font-weight: 580; letter-spacing: -0.01em; }
.help .hit:hover .hit-title { color: var(--accent); }
.help .hit-snippet { margin: 0.3rem 0 0; font-size: 0.9375rem; line-height: 1.5; color: var(--muted); }
.help mark { background: var(--mark); color: var(--mark-ink); border-radius: 3px; padding: 0 0.15em; }

/* ---- footer ------------------------------------------------------------ */

.help .colophon {
  border-top: 1px solid var(--hairline);
  background: var(--surface);
  padding: 2rem 0 2.5rem;
  font-size: 0.875rem;
  color: var(--muted);
}
.help .colophon .bar { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; justify-content: space-between; }
.help .colophon p { margin: 0; max-width: 34rem; }
.help .colophon a { color: var(--muted); }

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* ---- widths ------------------------------------------------------------ */

@media (min-width: 60rem) {
  .help .layout { grid-template-columns: 15rem minmax(0, 1fr); }
  .help .rail {
    order: 0;
    position: sticky;
    top: 4.25rem;
    max-height: calc(100vh - 5.5rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    padding: 0 0.5rem 1.5rem 0;
  }
  .help .doc { order: 1; }
}
@media (min-width: 78rem) {
  .help .layout { grid-template-columns: 15rem minmax(0, 1fr) 12rem; }
  .help .toc { order: 2; display: block; position: sticky; top: 4.5rem; }
}
@media (max-width: 40rem) {
  .help .masthead .bar { min-height: 3.25rem; }
  .help .find button { display: none; }
  .help .find input { width: 100%; }
  .help .masthead .find { flex: 1; max-width: 13rem; }
  .help .find-lg button { display: inline-block; }
  /* The sidebar follows the article on a narrow screen rather than preceding it: a reader
     who arrived from an error message wants the answer, not a table of contents. */
  .help .rail { border-top: 1px solid var(--hairline); padding-top: 1.5rem; }
  .help .rail ul { gap: 0; }
  .help .rail a { padding: 0.4rem 0.6rem; }
}
/* Below this the brand and the search field are fighting for the same row, and the field
   is the one a person came to use. */
@media (max-width: 30rem) {
  .help .brand-sep, .help .brand-kind { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .help * { transition: none !important; }
  .help .card:hover { transform: none; }
}

/* ---- dark -------------------------------------------------------------- */

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #101418;
    --surface: #171c21;
    --raised: #161b20;
    --ink: #e6e9ec;
    --muted: #9aa4ae;
    --hairline: #262d34;
    --control-border: #6d7780;
    --accent: #8fb4ff;
    --accent-wash: #1b2740;
    --mark: #5c4a12;
    --mark-ink: #f2f4f6;
    --figure: #eef1f4;
    --tone-0: #a8b8ff;
    --tone-1: #5ecfa4;
    --tone-2: #e5a56a;
    --lift: 0 1px 1px rgba(0, 0, 0, 0.3), 0 10px 24px -18px rgba(0, 0, 0, 0.8);
    --lift-hover: 0 1px 2px rgba(0, 0, 0, 0.35), 0 16px 32px -18px rgba(0, 0, 0, 0.9);
  }
  .help .find button { color: var(--paper); background: var(--ink); border-color: var(--ink); }
  .help .find button:hover { color: var(--paper); }
}
`;

/**
 * The sheet, as the browser has to receive it.
 *
 * dangerouslySetInnerHTML rather than a text child, and it is load-bearing rather than
 * stylistic: React escapes text inside a style element, so a declaration naming "Segoe UI"
 * arrived as &quot;Segoe UI&quot; and the browser dropped it — silently, along with every
 * other declaration containing a quote. The font stack was one. The search field's border,
 * whose contrast a WCAG test asserts, was another: measured in CI, absent from the page.
 *
 * Nothing dangerous goes through here. The argument is a constant in this repo and the
 * component takes no props, so there is no call site that could pass anything else.
 */
export function HelpStyles() {
  return <style dangerouslySetInnerHTML={{ __html: HELP_STYLES }} />;
}
