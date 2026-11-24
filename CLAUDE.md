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
2. **One writer per occurrence, and it is the worker.** A price write requires holding
   the `campaign_runs` row for `(campaign, occurrence, kind)` — a unique index, so the
   loser of the race defers rather than writing twice — and only one live run per campaign.
   The web process writes only a run of at most `MAX_INLINE_ROWS` (50) variants pressed on
   the campaign page, so a one-variant revert stays instant. Everything larger, and every
   Flow action, auto-enrol drain, catalogue sync and baseline capture, is a row first and a
   job second: the request enqueues and answers, the page follows the row, and Redis down
   means the worker's tick runs it — never the request. A request writing thousands of
   prices holds the pool every other shop's pages need (D29, #803).
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

## Agent skills

### Issue tracker

GitHub Issues on `rishu605/bulk-price-editor`, in the house style: a type label plus one
`area:*` and one `prio:*`, a problem → cause → acceptance-criteria body, and
issue → PR → merge. See `docs/agents/issue-tracker.md`.

### Triage labels

`needs-triage`, `question` (needs info), `ready-for-agent`, `ready-for-human`, `wontfix`.
They sit beside the type / `area:*` / `prio:*` labels and never replace them. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context. Decisions live only in `docs/decisions.md` (never `docs/adr/`); vocabulary
in the RFC, PRD and help concepts. See `docs/agents/domain.md`.

## State

Two development stores, documented in [`docs/environments.md`](docs/environments.md):
`boltify-apps.myshopify.com` for feature work and `anchor-perf.myshopify.com` at 102,132
variants for scale. The app record is linked and `client_id` is in `shopify.app.toml`.
