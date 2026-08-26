# Anchor help

## Concepts

Unfamiliar ideas that the rest of the product rests on. Worth ten minutes before your
first campaign.

- [What a baseline is](./concepts/baselines.md) — and why every campaign computes from it
- [How overlapping campaigns resolve](./concepts/resolver.md) — one winner per product, never stacked
- [Why revert recomputes](./concepts/revert.md) — rather than restoring old prices
- [What drift means](./concepts/drift.md) — when somebody changes a price behind the app
- [How rate limits affect a run](./concepts/rate-limits.md)
- [How guardrails work](./failures/guardrail-blocks.md) — the floors no campaign may price below

## How to

- [Your first campaign](./how-to/first-campaign.md)
- [Scheduling a sale](./how-to/schedule-a-sale.md)
- [Running a sale across several markets](./how-to/multi-market-sale.md)
- [Importing your own prices](./how-to/import-baselines.md)
- [Wiring pricing into Shopify Flow](./how-to/shopify-flow.md)

## When something goes wrong

- [Understanding a partial run](./failures/partial-runs.md)
- [A run that seems stuck](./failures/stuck-runs.md)
- [A guardrail stopped the run](./failures/guardrail-blocks.md)
- [When Shopify is unreachable](./failures/shopify-unreachable.md)
- [This store is no longer connected](./failures/store-disconnected.md)
- [Your session expired](./failures/session-expired.md)
- [The app is not responding](./failures/app-unavailable.md)
- [Something went wrong](./failures/unexpected.md)
