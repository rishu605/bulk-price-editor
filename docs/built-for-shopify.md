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
| Admin performance measured | `npm run measure:admin` against a real catalogue | met, see note |

**Note on admin performance.** `scripts/measure-admin.ts` times the catalogue and
reconciliation queries and prints an offset-scaling curve. It has been run against the
3,670-variant development store. It has **not** been run against 100K variants, because
that store does not exist yet (#50). The measurement is real; its coverage is not the
scale the criteria care about.

## Design

| Criterion | Evidence | Status |
|---|---|---|
| Polaris web components throughout | `never renders a raw HTML input other than a hidden one` | met |
| No full-page reloads | `uses no native form outside the App Bridge-safe wrapper` | met |
| Exemptions are genuine | `only excuses routes that genuinely render outside the admin` | met |
| Every form field labelled (WCAG AA) | `labels every form field` | met |
| Colour is never the only signal | — | gap |
| Contrast ratios verified | — | gap |

**The two design gaps are real and untested.** Both need a person looking at rendered
pages: a static test can see that a `tone` is set, not that the information survives
without it. They are the likeliest source of an audit finding, and they are cheap to fix
once someone has actually looked.

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
