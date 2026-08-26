# Built for Shopify — pre-submission audit

Nine of fourteen direct competitors carry the badge, which makes it an entry requirement
rather than a differentiator, and certification measurably moves App Store search rank.

Everything below that can be verified mechanically **is**, in
`app/lib/compliance/built-for-shopify.test.ts`, and runs on every CI build. A checklist
somebody ticked once is worth very little — the interesting failures are the ones
introduced later by a change that looked unrelated.

What follows records the rest: the criteria a test cannot check, how each was checked, and
the gaps that remain open with the reason.

---

## Performance

| Criterion | State | Evidence |
|---|---|---|
| No storefront speed impact | **Met by construction** | The app ships no theme app extension and no script tag. Campaign-scoped product tags are the storefront hook, so a merchant's theme reads a tag it already supports. Asserted by test. |
| Admin performance | **Partly measured** | Every list view narrows in SQL and pages at the database, never in memory — the reconciliation, baseline and activity views all do. Real thresholds need the 100K-variant store (#50), which is not yet seeded. |

The `s-table` cell budget (`app/lib/ui/table-budget.ts`) exists because the widget blanks
the page past a few hundred cells; it also keeps every table view small enough to render
quickly by construction.

---

## Design

| Criterion | State | Evidence |
|---|---|---|
| Polaris web components throughout | **Met** | Every visible control is a Polaris component. Only hidden inputs are native, and they have no Polaris equivalent. Asserted by test. |
| App Bridge embedding | **Met** | All admin routes authenticate through `authenticate.admin`, which is what makes the session token flow work. Asserted by test. |
| No full page reloads | **Met** | No native `<form>` anywhere in the embedded surface; navigation is React Router's `Link` and `Form`. Asserted by test. A native form would also break the app outright, since it wipes App Bridge's parameters. |
| WCAG AA | **Partly met — see below** | Every field is labelled, asserted by test. Colour contrast and keyboard navigation come from Polaris itself. |

**WCAG gaps, open:**

- **Colour contrast** is inherited from Polaris and has not been independently measured. Polaris meets AA by design; this app adds no custom colours, so the risk is low and the check is still owed.
- **Keyboard navigation and screen-reader flow** have not been tested by a person. This needs somebody using the app with a keyboard and a screen reader for half an hour, and it is not something automation substitutes for.
- **Focus management on route change** is React Router's default. Worth a pass before submission.

---

## Integration

| Criterion | State | Evidence |
|---|---|---|
| Latest supported API version | **Met** | One `API_VERSION` constant, `2025-10`, with no environment override — a worker and a web process on different versions is a class of bug that only shows up in production. Asserted by test. |
| Session-token authentication | **Met** | Every embedded route authenticates. Asserted by test. |
| Webhook HMAC verification | **Met** | Every webhook route goes through `authenticate.webhook`, which performs the check. Asserted by test. |
| Mandatory GDPR topics answered | **Met** | `customers/data_request`, `customers/redact` and `shop/redact` are registered and handled. Asserted by test. |
| Minimal scopes | **Met** | `write_products`, `read_markets`, `write_markets`. Each was established empirically in P0.2 rather than requested speculatively; the test fails if a fourth appears. |

---

## Admin performance, measured

Measured against the development store as it actually stands — **3,670 variants across
1,037 products**, including one at Shopify's 2,048-variant ceiling — rather than against an
empty database, where every query is fast and nothing is learned.

Server-side query time, warm, p50 of five runs:

| Page | p50 | max |
|---|---|---|
| Catalogue, page 1 | 8ms | 10ms |
| Catalogue, page 70 | 22ms | 28ms |
| Catalogue, text search | 4ms | 4ms |
| Reconciliation, page 1, every surface | 4ms | 5ms |
| Reconciliation, page 20 | 4ms | 5ms |

Comfortably inside the criteria. Two things are worth reading off it rather than only the
headline number.

**Reconciliation does not care which page you ask for.** 4ms at page 1 and 4ms at page 20,
over 3,696 variant × surface rows. That is the `DISTINCT ON` query and its indexes doing
their job, and it is the page most likely to be opened in anger.

**Catalogue pagination is offset-based, and the cost grows with the offset:**

```
page   1 (offset     0)   5ms
page  10 (offset   450)  10ms
page  30 (offset  1450)  19ms
page  50 (offset  2450)  21ms
page  73 (offset  3600)  20ms
```

Roughly 4× from the first page to the thirtieth, then flat — at this size the whole table
is cached, so the scan stops being the cost. **The plateau is a property of 3,670 rows, not
a property of the query**, and reading it as "offset pagination is fine" would be reading
it wrong. A skip of 50,000 has no cache to hide behind.

Whether that matters is a measurement nobody has taken, which is exactly what #66 is for —
the method is above, and the only missing ingredient is the 100K store. Switching to keyset
pagination is the known remedy and is deliberately not being done on a hypothesis.

## Still open before submission

These need a person, an account, or a deployed environment, and none of them can be closed
from the codebase:

- [ ] **Accessibility pass by a human** — keyboard-only and screen-reader, half an hour. The one gap above that automation cannot substitute for.
- [ ] **Admin performance at 100K variants** — measured at 3,670 above and comfortable; the open question is offset pagination at scale, not the pages themselves (#50, #66).
- [ ] **Listing assets and copy** (#172) and **review submission** (#173).
- [ ] **Staging drills with alerting live** (#161, #92) — confirming each alert fires and reaches a human.

## Deliberately not doing

- **A theme app extension.** The app's whole storefront contract is a tag. Adding theme code would create the storefront performance risk this section exists to avoid, and put us in the merchant's theme, which is the one place a pricing app has no business being.
