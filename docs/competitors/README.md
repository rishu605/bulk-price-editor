# Competitor teardowns

Three direct competitors are installed on `dartmode-labs.myshopify.com` and were walked
by hand on 29 Aug 2026. One file each, plus the comparison that turns them into work.

| | |
|---|---|
| [`na-bulk-price-editor.md`](na-bulk-price-editor.md) | **NA Bulk Price Editor** (Northern Apps) · 4.9★/227 · BFS · the app to beat |
| [`rubix-bulk-price-editor.md`](rubix-bulk-price-editor.md) | **RUBIX Bulk Price Editor** (Rubix House) · 4.8★/130 · BFS · feature-comparable, trust-incomparable |
| [`sami-bulk-price-editor.md`](sami-bulk-price-editor.md) | **Sami Bulk Price Editor** (SamiSales) · 4.8★/164 · BFS · newest, free, best craft |
| [`comparison.md`](comparison.md) | **The comparison and what to do about it** |

## How these were captured

Live, in the Shopify admin, on a store with 3,669 real variants — not from listings or
marketing copy. Every option list was enumerated by walking the control. Where a claim
comes from the App Store listing rather than the running app, the file says so.

Nothing destructive was done to the store. One task was created in Sami (`#75577`,
`Manual` start, never run) to observe its commit flow, and archived immediately. NA's
"Change market prices" setting was toggled on to reveal its markets step and toggled back
off. No prices were changed by any of them.

## Keeping them honest

A teardown of last month's UI is still a valid markdown file, so the same rule as
`docs/help/images/README.md` applies: **a ticket that cites one of these files should
re-check the claim it cites.** Re-walking one app takes about twenty minutes.
