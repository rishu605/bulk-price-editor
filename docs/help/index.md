# Anchor help

Anchor runs price campaigns against a baseline, so a discount never compounds, overlapping
campaigns resolve to one winner, and a revert is exact. These pages explain the ideas that
make that true, walk through the jobs merchants do most, and say what to do when a run
does not finish cleanly.

## Concepts

Unfamiliar ideas that the rest of the product rests on. Worth ten minutes before your
first campaign.

- [What a baseline is](./concepts/baselines.md) — and why every campaign computes from it
- [How overlapping campaigns resolve](./concepts/resolver.md) — one winner per product, never stacked
- [Why revert recomputes](./concepts/revert.md) — rather than restoring old prices
- [What drift means](./concepts/drift.md) — when somebody changes a price behind the app
- [How rate limits affect a run](./concepts/rate-limits.md) — why a large catalogue takes the time it takes
- [How guardrails work](./failures/guardrail-blocks.md) — the floors no campaign may price below

## How to

The jobs merchants do most, start to finish. Nothing here writes a price until you say so.

- [Your first campaign](./how-to/first-campaign.md) — fifteen minutes, from baselines to a verified run
- [Scheduling a sale](./how-to/schedule-a-sale.md) — a start, an end, and what happens at each
- [Running a sale across several markets](./how-to/multi-market-sale.md) — priced from each market's own normal price
- [Importing your own prices](./how-to/import-baselines.md) — when your storefront prices are already discounted
- [Wiring pricing into Shopify Flow](./how-to/shopify-flow.md) — three triggers and three actions for the rest of your stack

## When something goes wrong

Every error in the app links straight to the page that explains it. If you arrived here
instead, find the symptom.

- [Understanding a partial run](./failures/partial-runs.md)
- [A run that seems stuck](./failures/stuck-runs.md)
- [A guardrail stopped the run](./failures/guardrail-blocks.md)
- [When Shopify is unreachable](./failures/shopify-unreachable.md)
- [This store is no longer connected](./failures/store-disconnected.md)
- [Your session expired](./failures/session-expired.md)
- [The app is not responding](./failures/app-unavailable.md)
- [A form will not save](./failures/form-validation.md)
- [A campaign or record has gone](./failures/missing-record.md)
- [Something went wrong](./failures/unexpected.md)
