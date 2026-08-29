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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Metrics stay in the logs rather than going to a collector. |
| `RESEND_API_KEY` | No notification emails are sent. |
| `NOTIFICATION_FROM_EMAIL` | — required if `RESEND_API_KEY` is set |
| `OPERATOR_ALERT_EMAIL` | Nobody is paged for a systematic failure. |
| `HELP_BASE_URL` | Help links point at this deploy's own `/help`. Set it only to move the docs onto hosting that survives an outage of this app — `failures/app-unavailable` is otherwise served by the app it describes. |
| `SCHEDULER_TICK_MS` | Defaults to 30s. |
| `RUN_STALE_AFTER_MS` | Defaults to 5min — how long before the reaper treats a silent run as abandoned and makes it resumable. Raise it only if a legitimate run can go that long without a heartbeat. |
| `DATABASE_POOL_SIZE` | Defaults to 10 database connections **per process**, so web plus worker is 20. Measured in `docs/perf/README.md`: ten buys 91% of the throughput available at 40 for a quarter of the connections. Raise it only against a known `max_connections`, remembering that every service and every replica draws from the same budget, as does the `migrate deploy` each container runs at boot. A `connection_limit` already present in `DATABASE_URL` wins over this. |

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

`"degraded"` means Redis is unreachable and the queue is running jobs inline: campaigns
still apply, scheduling suffers. The check deliberately does not fail for it, because
taking the web service down over a degraded queue turns a partial outage into a total one.

For the worker, which has no endpoint, look for the tick line in its logs. Silence for
more than three minutes is the condition `TICK_SILENCE_SECONDS` alerts on.

---

## What is deliberately not automated

Provisioning, credentials and the Partner dashboard are done by a person. This document
exists so that is a checklist rather than an investigation — but creating paid resources
and pasting secrets should have somebody's judgement attached to it, not a script's.
