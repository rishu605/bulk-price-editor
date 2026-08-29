# Anchor — working notes

Shopify bulk price editor. A **price campaign manager** for multi-market stores, not a
"change many prices fast" tool — that market is commoditised (see `docs/decisions.md`).

**Read before non-trivial work:** [`docs/rfc-001-architecture.md`](docs/rfc-001-architecture.md)
(stack, data model, resolver, job engine) and [`docs/roadmap.md`](docs/roadmap.md) (which
phase we are in and what each task's acceptance criterion is).

## Architectural rules

These are not stylistic preferences. Breaking one produces a wrong price on a live
storefront, which is the failure mode the whole product exists to prevent.

1. **Campaign math reads the baseline, never the live price.** Relative edits against live
   values are why competitors' campaigns compound and their reverts drift.
2. **One writer per occurrence, whichever process it is.** A price write requires holding
   the `campaign_runs` row for `(campaign, occurrence, kind)` — a unique index, so the
   loser of the race defers rather than writing twice. The web process may write, and does:
   Apply, Revert, Resume and both Flow actions run inline. What bounds that is
   `MAX_INLINE_ROWS`, because a request that outlives its dyno leaves writes in flight with
   nobody reading the result.
3. **Ledger before write.** No Admin API price mutation without a `variant_changes` row
   already committed (invariant I4).
4. **Preview and execution share one code path.** `resolve()` runs in both modes; a preview
   that can disagree with execution is worthless.
5. **A run is "clean" only when every row is read-back verified.** Anything else is a
   visible, resumable partial state — never silence.
6. **Revert means recompute, not restore.** `resolve(without C)` — that is what makes
   overlapping campaigns, recurrence and partial failure all tractable.
7. **Money is integer minor units.** No floats anywhere near a price. Currency precision is
   explicit (JPY has no decimals).
8. **Never hardcode rate limits.** Read `extensions.cost.throttleStatus` from live
   responses; shops differ by plan.
9. **No theme code.** Ever. Campaign-scoped tags are the storefront hook.

## Commands

```shell
docker compose up -d      # local Postgres + Redis
npm run dev               # Shopify CLI dev server
npm run setup             # prisma generate && prisma migrate deploy
npm run typecheck         # react-router typegen && tsc --noEmit
npm run lint
npm run build
```

## Conventions

- **Prisma migrations are expand/contract only** — CI applies them to a clean Postgres, and
  a release must be rollback-safe one version back.
- **GraphQL is version-pinned and typed via codegen** (`npm run graphql-codegen`). Do not
  hand-write query types.
- **Every merchant-visible error names the object, the cause, and the next action.** See the
  error taxonomy in RFC §11.
- **Telemetry never carries price values** — shop id, plan, counts and durations only.

## State

Two development stores, documented in [`docs/environments.md`](docs/environments.md):
`boltify-apps.myshopify.com` for feature work and `anchor-perf.myshopify.com` at 102,132
variants for scale. The app record is linked and `client_id` is in `shopify.app.toml`.
