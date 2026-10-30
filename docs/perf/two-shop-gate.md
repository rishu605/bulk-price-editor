# The two-shop gate (#813)

The gate that proves Epic 19 (#807): **one shop's large write must never degrade another
shop.** Everything else in this directory is one shop, one request at a time (#516), and the
failure on 25 Sep only exists with two shops at once — anchor-perf's 102,132-variant apply ran
the web pool dry and every *other* shop's pages went blank for minutes (#803).

```shell
APP_URL=https://<web-domain> npm run gate:two-shops -- \
  --load-campaign <anchor-perf campaign id> --probe-campaign <DartMode Labs campaign id>
```

**Run it before any release that touches runs, webhooks or pooling.** It is not in CI: it
needs a deployment and both development stores, and it writes 102,132 prices twice.

## What it does

All at once, for as long as the load takes plus a tail:

| | Every | What |
|---|---|---|
| **anchor-perf** | once | Applies its 100% campaign (bulk path, a tag, markets on), waits until every row is verified, then reverts it the same way |
| **DartMode Labs** | 10 s | Loads Home, the probe campaign's page and Prices, one after another, as a merchant clicks |
| **DartMode Labs** | continuously | Applies and reverts its 1-variant campaign, timing each press to verified, 30 s between cycles |
| **`/healthz`** and **`/help`** | 5 s | `/help` touches no database: when it is slow too, the web process itself is slow, not only its pool |

After the load's revert settles it keeps sampling for `--tail` seconds (default 300), because
#803's aftermath — the echo flood of the run's own writes — kept the app at the timeout for 45+
minutes after the run was over. Then it reads the run rows, Diagnostics (`error_events`), drift
events and auto-enrolments for the window, judges the record and exits 1 on any miss.

`--apply scheduler` waits for the **scheduler** to start the load instead of pressing Apply —
schedule the campaign a few minutes out first. That is the run #813 says the gate must include:
on 25 Sep, *QA · sched* was started by the worker with no web request involved, and `/healthz`
still went from 0.33 s to 10.5 s, because the web pool was starved by the shared Postgres and by
the `products/update` echoes of the run's writes. `--revert scheduler` does the same for the end
(give the campaign an end date).

## SLOs — the run fails if it misses any

| SLO | Limit | Miss |
|---|---|---|
| DartMode Labs page loads, p95 — tail included | < 2 s | `observed-pages-p95` |
| …and every one of them answered 200 | all | `observed-pages-failed` |
| Every 1-variant apply, press to verified | < 30 s | `probe-apply-slow` |
| …and at least one pressed while the load was writing | ≥ 1 | `probe-unmeasured` |
| Every 1-variant apply and revert settled clean | all | `probe-unclean` |
| anchor-perf apply and revert both finish clean (every row verified) | both | `load-apply-unclean`, `load-revert-unclean` |
| P2024 / DB_UNAVAILABLE in Diagnostics, on **any** store | 0 | `pool-timeouts` |
| Drift events on either store (nobody edits during a gate, so each is a self-echo) | 0 | `self-echo-drift` |
| Auto-enrolments on either store, for the same reason | 0 | `self-echo-enrolments` |
| `/healthz` p95 | < 1 s | `healthz-p95` |
| …and every poll answered 200 | all | `healthz-failed` |

And the gate refuses to pass on too little: fewer than 20 page loads or 20 `/healthz` polls
(`observed-pages-unmeasured`, `healthz-unmeasured`), an apply that planned fewer than 100,000
rows or not on the bulk path (`load-not-representative`), or a probe that planned more than 10
rows (`probe-not-small`). A gate that passes because it measured nothing is worse than none.

The SLOs, the store allowlist and the verdict live in `app/lib/perf/two-shop-gate.ts`, pure and
tested over recorded samples (`two-shop-gate.test.ts`) — including the 25 Sep run, which fails
nine of them by name. `--out gate.json` saves the record, and `--evaluate gate.json` re-judges a
saved one offline, so a tightened SLO can be checked against past runs without a store.

## What it needs

All for the deployment under test, never filled in here:

| | |
|---|---|
| `APP_URL` | Its public URL |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Its Partner app credentials. The gate signs App Bridge session tokens for staff user 1 with the secret, as `test-page-actor` does; a mismatch is refused at preflight, before anything is pressed |
| `DATABASE_URL` | Its Postgres. **Read only** — use a read-only role. The gate reads run rows and Diagnostics and never writes; `scripts/gate-two-shops.test.ts` holds it to that |

And, set up once by hand in the app:

- **anchor-perf**: a campaign over the whole catalogue (102,132 variants) that adds a tag and
  has markets on, in Draft or Completed — or Scheduled, for `--apply scheduler`.
- **DartMode Labs**: a campaign over **one** variant, in Draft or Completed.

Both stores must be installed on the deployment. **It refuses any other store**: the load role
is `anchor-perf.myshopify.com` and nothing else, the observed role is DartMode Labs —
`dartmode-labs.myshopify.com`, or `boltify-apps.myshopify.com`, the domain
[`environments.md`](../environments.md) records for it; pass `--observed-shop boltify-apps` if
that is what the deployment has. Each campaign must belong to its store. Do not edit either
store while it runs: every drift event and auto-enrolment in the window is counted as the app's
own echo.

It writes only through the app's own page actions — Apply and Revert, exactly as a merchant
presses them — so it is a merchant, not a second writer. Interrupted, it says which campaign it
left with prices live.

## Expected results

**On `main` before #808–#812, it should fail** — that is the reproduction of #803: pages past
2 s while the 102,132-variant run writes, `/healthz` past 1 s, and probably pool timeouts and
self-echo drift. **Once #808–#812 land it should pass.** Neither has been measured yet: both
need the live stores and a deployment, and the first runs belong here.

| Run | Deployment | Result |
|---|---|---|
| — | — | not yet run |

The `/healthz` it polls is the one #813 made latency-aware: it reads `degraded` once `SELECT 1`
waits past 1 s or a queue is behind (`docs/deploying-to-railway.md`). A record whose `/healthz`
samples say `"ok"` while `databaseWaitMs` is seconds is the #803 signature, and the verdict
calls it out.
