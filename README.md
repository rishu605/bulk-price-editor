# Anchor — Shopify bulk price editor

A price **campaign** manager for Shopify stores that sell across multiple markets.

Where existing bulk price editors apply a relative edit to whatever the live price happens
to be — so re-runs compound, reverts drift, and half-finished jobs go unnoticed — Anchor
computes every price from a durable **baseline**, writes through a verified **change
ledger**, and treats Shopify Markets and B2B catalogs as first-class price surfaces rather
than a top-tier upsell.

> **Status: pre-development.** The scaffold is in place; feature work starts at phase P0.
> See [`docs/roadmap.md`](docs/roadmap.md).

## The three commitments

| | |
|---|---|
| **Baseline-anchored** | Campaign math reads a stored reference price, never the live price. Re-running a campaign is idempotent; reverting is exact. |
| **Every price surface** | One campaign prices base + Markets price lists + B2B catalogs, including per-market compare-at (supported by `priceListFixedPricesAdd`, shipped by almost nobody). |
| **Transactional** | Write-ahead ledger per variant, resumable jobs, read-back verification. A run is "clean" only when every row verifies — otherwise it is a visible, resumable partial state. |

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/prd.md`](docs/prd.md) | Personas, complete feature inventory, edge cases, non-functional requirements |
| [`docs/rfc-001-architecture.md`](docs/rfc-001-architecture.md) | Stack, data model, resolver algorithm, job engine, API write paths |
| [`docs/roadmap.md`](docs/roadmap.md) | Phase-by-phase task plan with acceptance criteria |
| [`docs/decisions.md`](docs/decisions.md) | Decision log — what is committed, what is open and when it resolves |
| [`docs/working-agreement.md`](docs/working-agreement.md) | How the issue tracker maps to these docs, and the rules for changing scope |
| [`docs/reference-patterns.md`](docs/reference-patterns.md) | Proven patterns from a production app on the same stack, and what to do differently |

Work is tracked in [GitHub Issues](https://github.com/rishu605/bulk-price-editor/issues),
organised as milestones (phases) → epics (feature areas) → tasks → subtasks. See the
working agreement for how the hierarchy is meant to be used.

## Getting started

### Prerequisites

- Node.js `>=22.12` (see `engines` in `package.json`)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started)
- Docker (for local Postgres + Redis)
- A [Shopify Partner](https://partners.shopify.com) account with a development store

### Setup

```shell
# 1. Local datastores
docker compose up -d

# 2. Environment
cp .env.example .env

# 3. Dependencies
npm install

# 4. Link to your Partner app (writes client_id into shopify.app.toml)
npm run config:link

# 5. Database schema
npm run setup

# 6. Run
npm run dev
```

### Everyday commands

| Command | Does |
|---|---|
| `npm run dev` | Shopify CLI dev server with tunnel + hot reload |
| `npm run setup` | `prisma generate && prisma migrate deploy` |
| `npm run typecheck` | React Router typegen + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run deploy` | Deploy app config + extensions to Shopify |

## Architecture in one paragraph

A **web process** (React Router 7, Polaris web components, embedded via App Bridge) serves
the admin UI and computes previews — it never writes prices. A **worker process** is the
only writer: a leader-elected scheduler tick finds due campaign transitions, a planner
materialises ledger rows by diffing the resolver's output against the mirrored catalog, and
an executor writes them via `productVariantsBulkUpdate` (small runs) or
`bulkOperationRunMutation` with staged JSONL (everything else, since bulk operations carry
no rate-limit cost). A verifier reads back and marks each row. Postgres holds the catalog
mirror, baselines and ledger; Redis holds the queue. Full detail in
[`docs/rfc-001-architecture.md`](docs/rfc-001-architecture.md).

## License

Unlicensed / private. All rights reserved.
