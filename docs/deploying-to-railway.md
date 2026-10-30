# Deploying to Railway

Two services from one repository, per [D5](decisions.md). The worker is the only process
that writes prices, so it restarts and scales on its own — a slow campaign must never tie
up a request thread, and a web deploy must never interrupt a run mid-write.

Both services build the **same image**. They differ in their start command and in which
config file they read — and the second one is not optional.

`railway.json` carries `healthcheckPath: "/healthz"`, and Railway applies a repo's config
file to *every* service built from it. The worker serves no HTTP, so it inherited a
healthcheck it can never answer: build succeeded, deploy succeeded, then
`Network > Healthcheck` failed after the 120-second timeout and the deployment was marked
FAILED. Nothing about that error names the healthcheck as the *wrong setting for this
service* rather than a broken app, which is what makes it worth writing down.

So the worker points at `railway.worker.json`, which is the same build with no healthcheck
and the worker's start command.

### These config files have an expiry date

Railway has deprecated Config as Code. Two dates, and only one of them is far away:

| | |
|---|---|
| **2026-08-28** | services that have never used Config as Code can no longer opt in |
| **2026-12-01** | existing `railway.json` / `railway.worker.json` files stop being read — hard cutoff |

Both services opted in before the first date, so they are grandfathered and nothing is
broken today. The replacement is Infrastructure as Code — a `.railway/railway.ts` applied
through the CLI with `railway config plan` / `railway config apply`, and a
`railway config migrate` that generates it from these files. It is explicitly beta, and
its own docs say the generated formatting may still change, so there is no hurry to adopt
it for a deployment that works.

**The trap is the first date, not the second.** If the worker service is ever deleted and
recreated — which is exactly what somebody would do to fix a broken deploy — the new
service cannot opt into Config as Code, `railway.worker.json` will not be read, and it
inherits the healthcheck problem with no file-based way out.

So set the same two values in the worker's **dashboard** settings as well: start command
`npm run worker`, healthcheck path empty. Config as Code overrides dashboard values while
it is read, so this changes nothing today — and on 2026-12-01, when the files stop being
read, the dashboard values are already correct and the cutoff passes as a no-op rather
than as an outage.

Building
twice would let them drift, and the pair that must never disagree about a price is exactly
this pair: the worker writes what the web process previewed.

---

## Services

| | Web | Worker |
|---|---|---|
| Start command | `npm run docker-start` (the image default) | `npm run worker` |
| Public domain | yes | **no** |
| Healthcheck | `/healthz` | none — it serves no HTTP |
| Config-as-code | `railway.json` (the default) | **`railway.worker.json`** — set it under Settings → Config-as-code |
| Runs migrations | **yes** | no |
| Replicas | scale freely | **exactly one** |

**Only the web service migrates.** `docker-start` runs `prisma migrate deploy` before
serving. Two services racing the same migration on deploy is a lock fight at best and a
half-applied schema at worst.

**The worker stays at one replica.** It takes a Redis leader lock, so a second copy is
mostly harmless — it idles. But "mostly harmless" is not a property to lean on for the only
process allowed to write prices, and there is nothing to gain: throughput is bounded by
Shopify's rate limit, not by our CPU.

---

## Environment variables

Set on **both** services unless noted. Railway injects `DATABASE_URL` and `REDIS_URL`
automatically once Postgres and Redis are attached — reference them rather than pasting
values, so a credential rotation does not need a redeploy.

### Required

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference, don't paste |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | Reference, don't paste |
| `SHOPIFY_API_KEY` | from the Partner dashboard | |
| `SHOPIFY_API_SECRET` | from the Partner dashboard | secret |
| `SHOPIFY_APP_URL` | the web service's public URL | must match the Partner app exactly |
| `SCOPES` | `write_products,read_markets` | must match `shopify.app.toml` |
| `TOKEN_ENCRYPTION_KEY` | 32+ random bytes | secret — see below |
| `NODE_ENV` | `production` | set by the Dockerfile; override only to debug |
| `RESEND_API_KEY` | from Resend | secret — support requests and notification emails |
| `NOTIFICATION_FROM_EMAIL` | a sender on a domain verified in Resend | never `onboarding@resend.dev` — see below |
| `SUPPORT_EMAIL` | where support requests arrive | |

**The three mail variables are required in production.** Without them Contact support
cannot send: the page says so and shows the support address instead, and `/healthz` reads
`"degraded"` with a `mail` entry naming them. Shopify's review expects a working support
contact, and a merchant at an error page is the worst person to send on a detour.

**Set them on both services, as shared variables.** The web service sends what a merchant
presses — Apply, Revert, Contact support, Send test email — and the worker sends what a
schedule or the queue runs, so a variable on the web service alone leaves every scheduled
end silent. Production went from #758 to App Review with none of them set: the reviewer
saved an address, reverted a campaign to trigger its email, and none came (#1118).

**The sender must be on a domain verified in Resend.** `onboarding@resend.dev`, or any
unverified domain, is delivered only to the Resend account owner's own address. Everything
looks configured, `/healthz` reads `ok`, and a merchant's or a reviewer's address receives
nothing. Settings → Notifications → **Send test email** to an address outside the Resend
account is the check.

**`TOKEN_ENCRYPTION_KEY` is not optional in a deployed environment.** Access tokens are
encrypted at the session-storage layer, and without the key the worker reads ciphertext and
sends it to Shopify as a bearer token. Shopify answers "Invalid API key or access token",
which reads like a misconfigured app and sends you looking anywhere but at this variable.

Generate one with `openssl rand -base64 48`. **Losing it invalidates every stored session**
— every merchant has to reinstall — so put it somewhere durable before the first deploy,
not after.

### Optional, and honest about being absent

| Variable | Absent means |
|---|---|
| `SENTRY_DSN` | Errors stay local. Every failure still lands in `error_events` with an id a merchant can quote. |
| `SENTRY_RELEASE` | Falls back to `SOURCE_VERSION`, then `RAILWAY_GIT_COMMIT_SHA`. With none of them, Sentry releases are untagged and Contact support's "App version" reads `dev`, so a support thread cannot be lined up with a stack trace. |
| `SOURCE_VERSION` | The build's commit, where the platform provides one (Heroku does; Railway does not); the first fallback for `SENTRY_RELEASE`. |
| `RAILWAY_GIT_COMMIT_SHA` | Set by Railway on every deploy, never by hand: the deployed commit, and the release name when neither variable above is set (#1147). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Metrics stay in the logs rather than going to a collector. |
| `OPERATOR_ALERT_EMAIL` | Nobody is paged for a systematic failure. |
| `HELP_BASE_URL` | Help links point at this deploy's own `/help`. Set it only to move the docs onto hosting that survives an outage of this app — `failures/app-unavailable` is otherwise served by the app it describes. |
| `SCHEDULER_TICK_MS` | Defaults to 30s. |
| `RUN_STALE_AFTER_MS` | Defaults to 5min — how long before the reaper treats a silent run as abandoned and makes it resumable. Raise it only if a legitimate run can go that long without a heartbeat. |
| `BILLING_TEST_CHARGES` | Charges are real on real stores and test charges on development stores, decided per shop (#860). Set it to `true` only on a staging deploy, where every plan change should be a test charge. **Never on production**: no merchant would ever be billed. |
| `DATABASE_POOL_SIZE` | Defaults to 10 database connections **per process**, so web plus worker is 20. Measured in `docs/perf/README.md`: ten buys 91% of the throughput available at 40 for a quarter of the connections. Raise it only against a known `max_connections`, remembering that every service and every replica draws from the same budget, as does the `migrate deploy` each container runs at boot. A `connection_limit` already present in `DATABASE_URL` wins over this. The two variables below win over it, per process. |
| `DATABASE_POOL_SIZE_WEB` | The web service's pool, per replica. Falls back to `DATABASE_POOL_SIZE`, then 10. See [Database connections](#database-connections) for the budget it is checked against. |
| `DATABASE_POOL_SIZE_WORKER` | The worker's pool — the one a run lives in. Falls back to `DATABASE_POOL_SIZE`, then 10. |
| `DATABASE_POOL_RESERVE` | Defaults to 5: connections nothing in the app opens, kept for the boot-time `migrate deploy`, `psql` and Railway's dashboard. Counted in the boot check, never used. |
| `WEB_REPLICAS` | Defaults to 1. How many web replicas the boot check counts a full web pool for. Set it when you scale the web service, or the check under-counts. |
| `DATABASE_POOL_TIMEOUT_WEB_S` | Unset leaves Prisma's 10 s. Whole seconds a web query waits for a free connection before failing with "the app's own database is not responding". Web only; the worker waits out pool timeouts by retrying instead. |
| `DATABASE_STATEMENT_TIMEOUT_WEB_MS` | Unset means none. Milliseconds a web statement may run before Postgres cancels it and the page says the database is busy and to reload. **Web only** — never the worker, never migrations. Inline Apply, Revert and Resume run in the web process too, so measure before you go below a few seconds. |
| `DATABASE_DIRECT_URL` | Unset means migrations use `DATABASE_URL`, as always. Set it — to Postgres itself, not the pooler — once `DATABASE_URL` points at PgBouncer: `prisma migrate deploy` cannot run through transaction pooling. Read only by `scripts/migrate.ts`. |

---

## Database connections

Each process has its own pool, and every process checks the sum at boot (#810). The numbers
that matter, and the line that reports them:

```
INFO  database pool budget: web 15 + worker 22 + reserve 5 = 42, within max_connections 100 − 3 reserved for superusers = 97 (55 spare)
```

Over budget is an **error** line ending in what to change; it does not stop the process,
because a boot refused over a sizing mistake is an outage and a pool that is too big is a
slowdown at peak. Search the logs for `database pool budget exceeded` after changing any of
the pool variables or the Postgres plan. The same line, as a warning, says when a statement
timeout was asked for and the session did not get it.

**The budget.** `web × WEB_REPLICAS + worker + DATABASE_POOL_RESERVE` must fit under
`max_connections` minus the superuser slots. Railway's Postgres runs the stock image, whose
`max_connections` is 100 — check yours with `SHOW max_connections;`, since a plan or a
custom config can change it, and the boot line prints what it read. The recommendation,
against 100: web 15, worker 22, reserve 5, which leaves room for a second web replica.

**Why the worker's is the bigger pool.** It is every queue's as well as the run's: the
products-webhook drains (#811, ten at once), planning (five), execution and verification
(two each), sync and audit (one each), and the scheduler's tick, which runs due campaigns
itself — 22 jobs that can each be holding a connection. The worker's boot line warns when
`DATABASE_POOL_SIZE_WORKER` is below that count and says what it counted; a run waits out a
pool timeout by retrying the statement, but this decides how often it has to.

**The page timeouts.** Recommended once the budget is set: `DATABASE_POOL_TIMEOUT_WEB_S=2`
and `DATABASE_STATEMENT_TIMEOUT_WEB_MS=5000`. A page then fails in a couple of seconds with
a sentence naming the cause, rather than waiting ten behind a run. Both are off by default
because the web process also writes (Apply, Revert and Resume run inline), and the right
statement limit is one measured against those writes on your database.

**How busy the pool is.** `db.pool_wait_ms`, a histogram labelled `process: web | worker`,
is a `SELECT 1` timed every 10 s in each process — connection wait plus one round trip.
#810's target is web p95 under 1 s while a 102k-variant run writes. `db.transient_retries`
counts the run's writes that hit P2024 or P2034 and were retried (`outcome: retried`) or ran
out of retries (`outcome: gave_up`, which is a run that went Partial because of load).

### Putting PgBouncer in front (a person's job)

Transaction pooling lets both services keep their client pools while Postgres sees only
PgBouncer's. The app is ready for it; the provisioning is not automated.

1. **Add PgBouncer** to the Railway project (Railway's PgBouncer template, or the
   `edoburu/pgbouncer` image) with `POOL_MODE=transaction`, pointed at the Postgres service's
   private URL. Size its `DEFAULT_POOL_SIZE` (server connections) under `max_connections`
   with the reserve to spare — that is now the number that has to fit.
2. **Point `DATABASE_URL` at PgBouncer** on both services, with `pgbouncer=true` on the query
   string — Prisma then stops using named prepared statements, which transaction pooling
   cannot keep. Keep the pool variables above: they now size the clients' pools against
   PgBouncer.
3. **Set `DATABASE_DIRECT_URL`** on the web service to the Postgres service's own URL
   (`${{Postgres.DATABASE_URL}}`). Only migrations use it; without it the boot's
   `migrate deploy` goes through PgBouncer and fails on its advisory lock.
4. **Move the web statement timeout onto a role.** Behind `pgbouncer=true` the app does not
   send `statement_timeout` as a startup option (PgBouncer refuses or drops it), so give the
   web service its own Postgres role and run
   `ALTER ROLE anchor_web SET statement_timeout = '5s';` — and give the worker a role
   without one. The boot line warns when the web session's timeout is not what
   `DATABASE_STATEMENT_TIMEOUT_WEB_MS` asked for, and when the worker's is not zero.
5. **Redeploy both**, then read the boot lines and `/healthz`.

---

## First deploy, in order

Order matters here in a way it usually does not, because two of these steps are hard to
undo.

1. **Provision Postgres and Redis** in the Railway project.
2. **Create the web service** from this repo. Set the variables above. Deploy.
3. **Wait for `/healthz` to answer.** It reports the database and Redis separately, so a
   failure here names which one rather than leaving you to guess.
4. **Take the generated domain** and set `SHOPIFY_APP_URL` to it, then set the same URL in
   the Partner dashboard as the app URL and the allowed redirect URL. **Redeploy the web
   service** — the value is read at boot.
5. **Create the worker service** from the same repo. Same variables, start command
   `npm run worker`, no public domain, one replica.
6. **Install the app on a store** and confirm the first sync runs.

**Do not create the worker before the first successful web deploy.** The worker's first
tick will try to read a schema that the web service has not migrated yet, and a worker that
crashloops on boot looks identical to a worker with a bad database URL.

---

## Verifying a deploy

```
curl -s https://<web-domain>/healthz | jq
```

```jsonc
{ "status": "ok", "database": { "ok": true }, "redis": { "ok": true } }
```

`"degraded"` means something the app can run without is missing, and the entry with
`"ok": false` says which:

- `redis` — the queue is running jobs inline: campaigns still apply, scheduling suffers.
- `scheduler` — the worker has stopped or never started.
- `mail` — the mail variables above are not all set, so Contact support cannot send.

The check deliberately does not fail for any of them, because taking the web service
down over one turns a partial outage into a total one.

For the worker, which has no endpoint, look for the tick line in its logs. Silence for
more than three minutes is the condition `TICK_SILENCE_SECONDS` alerts on.

---

## What is deliberately not automated

Provisioning, credentials and the Partner dashboard are done by a person. This document
exists so that is a checklist rather than an investigation — but creating paid resources
and pasting secrets should have somebody's judgement attached to it, not a script's.
