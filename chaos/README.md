# Chaos suite

Six scenarios that deliberately break the engine mid-run and assert it ends
**verified-clean or visibly partial — never silently wrong.**

```shell
npm run test:chaos                      # needs Postgres and Redis running
CHAOS_SEED=20260829 npm run test:chaos  # replay a specific failure
npx vitest run --config vitest.chaos.config.ts chaos/scenarios/worker-death.chaos.ts
```

## What it asserts, and what it does not

The assertion is deliberately **not** "the run succeeds". Under a 429 storm or a
mid-run deletion it sometimes should not, and a suite that demanded success would
push the engine toward optimistic reporting — the exact defect this category is
full of.

`chaos/harness/verdict.ts` holds the real assertion. Every scenario ends in one of
two honest states, and there is no third:

| | |
| --- | --- |
| **verified clean** | every row read back and confirmed against the live store |
| **visibly partial** | rows outstanding, each with a reason, campaign showing `PARTIAL`, resume able to continue |

A `VERIFIED` row whose live price disagrees, a `COMPLETED` run with unfinished
work, or a price written with no ledger row behind it (invariant I4) fails here.

## Scenarios

| Scenario | Breaks | Proves |
| --- | --- | --- |
| `worker-death` | SIGKILL mid-chunk, real child process | Reclaimed as partial, resume converges on the identical state (E2) |
| `postgres-drop` | Connection cut mid-writes | No unledgered write (I4), resume converges |
| `redis-restart` | Leader lock lost, split brain | Deposed leader finds out; a double-apply neither crashes nor compounds |
| `webhook-drop` | `bulk_operations/finish` never arrives | Poll fallback recovers, every row verified from the result file (E13) |
| `throttle-storm` | 429 on every other request | Run slows, completes, never errors (E17) |
| `product-deleted` | Variant deleted mid-run | Row skipped, run continues (E4) |

## How it is wired

The engine under test is the real one — `runCampaign` against a real Postgres,
through the real planner, executors, ledger and state machine. Only the store is a
stand-in:

- **`shopify-server.ts`** serves a modelled Shopify over loopback HTTP. It is a
  server rather than an injected object because the kill scenarios run the engine in
  a child process, faults belong on the wire, and the bulk path genuinely uploads and
  streams with `fetch`.
- **`fake-shopify.ts`** models the *awkward* parts faithfully: `userErrors` on HTTP
  200, a throttle bucket that drains and restores, and a bulk operation that does not
  finish on submission.
- **`faults.ts`** turns "throttle every other write" into a rule, applied at the wire
  in Shopify's real error shapes.
- **`tcp-proxy.ts`** cuts Postgres and Redis connections precisely, without stopping
  the services the harness itself needs.
- **`worker-process.ts`** spawns and SIGKILLs a real child, timed off writes the
  store has actually accepted — so "mid-chunk" means mid-chunk on every machine.

## When one fails

Failures write `chaos/artefacts/<scenario>.md`: the seed to replay with, the run id,
every ledger row's state and reason, and every write the store accepted. The fixture
shop is deliberately **left in the database** on failure so the ledger can be opened
afterwards. CI uploads the artefacts.

`retry: 0`, on purpose. A chaos suite that retries launders a real intermittent bug
into a green tick — which is the reporting dishonesty the suite exists to catch the
engine doing.
