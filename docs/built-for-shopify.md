# Built for Shopify — pre-audit

Nine of fourteen direct competitors carry the badge. It is an entry requirement rather
than a differentiator, and certification measurably moves App Store search rank.

This is the evidence sheet for submission. Every row names **what proves it**, and a test
in `app/lib/compliance/built-for-shopify.test.ts` asserts that each named test actually
exists — so a criterion cannot quietly lose its evidence when somebody renames a test.

Rows marked **gap** are not met. They are listed rather than omitted, because a checklist
that only contains passes is a checklist nobody checked.

## Performance

| Criterion | Evidence | Status |
|---|---|---|
| No storefront speed impact | `ships no theme app extension` | met |
| Admin performance measured | `npm run measure:admin` against 102,132 variants | met |

**Note on admin performance.** Measured against a real 102,132-variant store: the
catalogue's first page is 26 ms, its last page 292 ms at offset 101,100, and reconciliation
stays under 10 ms throughout. Full numbers in `docs/perf/README.md`.

Building that store found a defect the smaller one could not: `variants(first: 100)` in the
catalogue sync silently dropped 1,948 of a 2,048-variant product, so a campaign covering it
would have priced 100 variants and reported clean. Fixed in #291.

What these numbers do not cover is concurrency — every measurement is one request at a time
against an idle store, which makes them a floor rather than a forecast.

## Design

| Criterion | Evidence | Status |
|---|---|---|
| Polaris web components throughout | `never renders a raw HTML input other than a hidden one` | met |
| No full-page reloads | `uses no native form outside the App Bridge-safe wrapper` | met |
| Exemptions are genuine | `only excuses routes that genuinely render outside the admin` | met |
| Every form field labelled (WCAG AA) | `labels every form field` | met |
| Colour is never the only signal (WCAG 1.4.1) | `every tone is accompanied by words` | met, see note |
| Contrast ratios verified (WCAG 1.4.3, 1.4.11) | `light palette meets AA` / `dark palette meets AA` | met |

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

## Integration

| Criterion | Evidence | Status |
|---|---|---|
| One pinned API version, no override | `pins one API version, with no environment override` | met |
| That version is still supported | `pins an API version Shopify still supports` | met until 2026-10 |
| Session-token auth on every embedded route | `authenticates every embedded route` | met |
| Webhook authenticity checked | `authenticates every webhook route` | met |
| All three mandatory GDPR topics | `registers all three mandatory GDPR topics` | met |
| Scopes limited to what the app uses | `keeps requested scopes to the ones the app demonstrably uses` | met |
| No write access the app does not exercise | `sends no mutation that would need write access to markets` | met |

**The API version expires 2026-10-01.** `October25` was released in October 2025 and
versions are supported for twelve months. The test above fails once that date passes;
the fix is to bump the pin and regenerate types, not to move the deadline. Doing it
*before* submission is considerably cheaper than doing it during review.

## What this sheet does not cover

Submission itself (#173), the App Store listing (#172), and the accessibility review that
would close the two design gaps. Those need a Partner account and a person respectively.
