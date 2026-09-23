# Built for Shopify — pre-audit

Nine of fourteen direct competitors carry the badge. It is an entry requirement rather
than a differentiator, and certification measurably moves App Store search rank.

This is the evidence sheet for submission. Every row names **what proves it**, and a test
in `app/lib/compliance/built-for-shopify.test.ts` asserts that each named test actually
exists — so a criterion cannot quietly lose its evidence when somebody renames a test.

Rows marked **gap** are not met. They are listed rather than omitted, because a checklist
that only contains passes is a checklist nobody checked.

## What the badge is actually gated on

Worth saying before the technical rows, because the technical rows are the part that looks
like progress and they are not the part that is binding.

| Criterion | Threshold | Status |
|---|---|---|
| Net installs from active shops on paid plans | 50 | gap — not launched |
| Reviews | 5 | gap — not launched |
| Recent app rating | a minimum Shopify does not publish | gap — not launched |
| Admin performance measurements collected | 100 per metric over 28 days | gap — needs live traffic |
| Good Partner standing, no outstanding infractions | Partner Dashboard | not checkable here |

None of those five can be closed by writing code, and four of them cannot be started until
the app is listed (#172) and submitted (#173). The honest reading of this sheet is that
everything below it is *necessary and not sufficient*: it makes the app pass the audit on
the day it becomes eligible, and it does nothing to bring that day closer.

The order matters in one direction, though. The Web Vitals thresholds are measured from
real merchant sessions over a rolling 28 days, so anything that makes them worse is
discovered a month late, against a population that has already installed. That is the
argument for fixing the App Bridge placement below *before* launch rather than after.

## Performance

| Criterion | Evidence | Status |
|---|---|---|
| No storefront speed impact | `ships no theme app extension` | met |
| Admin performance measured | `npm run measure:admin` against 102,132 variants | met |
| App Bridge can observe the page it reports on | `loads App Bridge from the document head` | met |
| One copy of App Bridge, not two | `loads App Bridge exactly once` | met |

**The thresholds.** LCP at or under 2.5s, CLS at or under 0.1, INP at or under 200ms —
each at the 75th percentile, each needing at least 100 measurements over 28 days. Shopify
collects all three; the app's only job is to be instrumented correctly and to be fast.

**Why the script's position is a performance row and not an integration one.** App Bridge
is the reporter. It observes paint and layout-shift entries from the moment it executes,
so a copy that loads late does not report late — it never sees what happened before it,
and a largest contentful paint it missed cannot be recovered afterwards.

This was wrong until 2026-09-23, and wrong in a way nothing would have surfaced.
`AppProvider` renders the script tag at its own position in the React tree, which is
inside `<body>`. That is correct under React 19, which hoists `<script src>` into the
head; this app is on React 18, which does not. So the app was fully instrumented, reported
nothing broken, and measured the three metrics the badge is graded on from halfway down
the document. `root.tsx` owns both script tags now and `AppBridgeNavigation` owns the
`shopify:navigate` listener that came with them.

**Note on admin performance.** Measured against a real 102,132-variant store: the
catalogue's first page is 26 ms, its last page 292 ms at offset 101,100, and reconciliation
stays under 10 ms throughout. Full numbers in `docs/perf/README.md`.

Building that store found a defect the smaller one could not: `variants(first: 100)` in the
catalogue sync silently dropped 1,948 of a 2,048-variant product, so a campaign covering it
would have priced 100 variants and reported clean. Fixed in #291.

What these numbers do not cover is concurrency — every measurement is one request at a time
against an idle store, which makes them a floor rather than a forecast. They also measure
the server, and the criteria measure the browser.

## Design

| Criterion | Evidence | Status |
|---|---|---|
| Polaris web components throughout | `never renders a raw HTML input other than a hidden one` | met |
| No full-page reloads | `uses no native form outside the App Bridge-safe wrapper` | met |
| Exemptions are genuine | `only excuses routes that genuinely render outside the admin` | met |
| No duplicate homepage nav item | `renders the home item as rel="home" and not as a menu entry` | met |
| Modals titled through the admin's own slot | `gives every modal a heading` | met |
| Modal buttons in the admin's action slots | `puts every modal's buttons in the action slots` | met |
| Every form field labelled (WCAG AA) | `labels every form field` | met |
| Colour is never the only signal (WCAG 1.4.1) | `every tone is accompanied by words` | met, see note |
| Contrast ratios verified (WCAG 1.4.3, 1.4.11) | `light palette meets AA` / `dark palette meets AA` | met |

**The nav item was a named rejection reason**, not an inference: *"an app has a separate
navigation item in addition to the app name that redirects to the app's homepage. Instead,
the app name should point at the app's homepage."* The admin sidebar already renders the
app's name as a link home, so the `Home` item next to it was the second one. `rel="home"`
fixes both halves — it repoints the app name from the default `/` to `/app`, and it hides
its own item from the rendered menu.

Deleting the link would also have removed the duplicate, and would have left the app name
pointing at `/`, which only reaches the app because `_index` redirects. That is an extra
round trip on the most-clicked link in the app, to arrive where one attribute could have
pointed directly.

**Contrast is computed, not eyeballed.** Polaris renders most of this app and its contrast
is Shopify's responsibility; the help centre ships its own stylesheet and is ours. Both its
palettes are checked against the CSS as shipped rather than a list kept beside it. Doing
this found two real failures: the search field's border was 1.66:1 in light and 1.96:1 in
dark, against the 3:1 that WCAG 1.4.11 asks for on a control's boundary — visible to most
people, invisible to some, and the sort of thing only ever found by computing it.

**What the colour test can and cannot do.** It refuses a status tone with no content at
all — a badge that is a coloured dot, a cell tinted by state with nothing in it. It cannot
judge whether the words beside a colour actually explain it; that still wants a person.
`neutral` is excluded deliberately: it means "this matters less", which is not information
a reader loses without colour.

**Checked by reading, not by a test.** Spelling and grammar in headings and calls to
action; no countdown timers, no guilt-inducing copy, no review solicitation; no modal or
popover that opens on load; red used only for errors and destructive actions; the app icon
not resembling a first-party Shopify one. These are real criteria and they are all
currently satisfied; none of them is enforced, so any of them can regress silently.

## Integration

| Criterion | Evidence | Status |
|---|---|---|
| One pinned API version, no override | `pins one API version, with no environment override` | met |
| That version is still supported | `pins an API version Shopify still supports` | met until 2027-07 |
| Session-token auth on every embedded route | `authenticates every embedded route` | met |
| Webhook authenticity checked | `authenticates every webhook route` | met |
| All three mandatory GDPR topics | `registers all three mandatory GDPR topics` | met |
| Scopes limited to what the app uses | `keeps requested scopes to the ones the app demonstrably uses` | met |
| No write access the app does not exercise | `sends no mutation that would need write access to markets` | met |

**The pin is `2026-07`, supported until 2027-07-01.** Versions are released quarterly and
supported for twelve months, and the deadline is derived from the version string rather
than written down, so bumping the pin moves it. The test above fails once that date
passes; the fix is to bump and regenerate types, not to move the deadline.

**Criteria met by construction, with nothing to cite.** Primary workflows all run inside
the admin — the UI links to no external host, checked by grep and true today. No
additional sign-up after install: the app authenticates through the session token and has
no account of its own. No theme files are touched, through the Asset API or otherwise, so
"uninstalls cleanly" is satisfied by there being nothing to remove; the three extensions
are Flow triggers and actions, not theme app extensions. The name "Anchor" does not
truncate in the admin sidebar.

## What this sheet does not cover

Submission itself (#173) and the App Store listing (#172), which between them gate every
row in the first table. The category-specific criteria do not currently apply — but the
discount-mode work in #179 would move the app into the Discounts category, which brings
its own requirements (discount functions or native discount APIs, and no draft orders),
and that is worth knowing before the design is settled rather than after.
