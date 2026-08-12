# Reference patterns from `ai-crawl-it-not`

[`rishu605/ai-crawl-it-not`](https://github.com/rishu605/ai-crawl-it-not) is a production
Shopify app on the **same stack this project committed to**, by the same author. Where it
has already solved a problem, copy the shape rather than rediscovering it.

Clone it as a sibling directory to read alongside this repo:

```shell
git clone https://github.com/rishu605/ai-crawl-it-not.git ../ai-crawl-it-not
```

## What it independently validates

Every architectural choice in [RFC-001 §1](rfc-001-architecture.md) is already running in
production there:

| RFC-001 choice | Confirmed in `ai-crawl-it-not` |
|---|---|
| React Router 7 + `@shopify/shopify-app-react-router` | ✅ same package |
| Postgres + Prisma | ✅ `provider = "postgresql"`, `env("DATABASE_URL")` |
| Redis + BullMQ, separate worker process | ✅ `bullmq` + `ioredis`, standalone worker entry |
| Managed pricing | ✅ plus `app_subscriptions/update` webhook |

This is about as good as pre-build validation gets: the stack is not theoretical here.

## Hosting — resolves decision D5

**Railway, with the web app and the worker as two services deployed from one repo.** Each
service points at its own config file:

```jsonc
// railway.json — web service
{ "build": { "builder": "RAILPACK", "buildCommand": "npm run build:production" },
  "deploy": { "startCommand": "npm start",
              "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10 } }

// railway-worker.json — worker service, same build, different start
{ "deploy": { "startCommand": "npm run worker" } }
```

Migrations run at **build** time, not deploy time:

```
"build:production": "prisma generate && prisma migrate deploy && react-router build"
```

That ordering matters for us: our expand/contract migration policy means a migration must
be safe against the *previous* running version, because it lands before the new code does.

There is also an `ecosystem.config.cjs` (PM2) for running both processes in a single
service. **We should not use it** — our worker is the only price writer, and giving it its
own service means it can be restarted, scaled and rate-limited independently of web traffic.

## Worker process shape

Worth copying directly (`scripts/start-validation-worker.ts`):

- **Validate required env vars at boot and exit(1) with a readable message.** A worker that
  starts without credentials and fails silently per-job is much harder to debug than one
  that refuses to start.
- **SIGTERM *and* SIGINT both close the queue before `process.exit(0)`.** This is what makes
  a deploy mid-run safe — for us, it is the difference between a resumable campaign and a
  stuck one (task P0.5).
- Entry runs through `tsx`, so the worker shares TypeScript source with the app rather than
  needing a separate build.

### One thing to do differently

Their worker deliberately **suppresses Redis connection errors** to keep logs quiet. Do not
copy that. For us a dropped Redis connection means a lost job, and a lost job means a
campaign that half-applied — the exact failure this product exists to prevent. Ours should
surface loudly and alert. Related: set Redis `maxmemory-policy` to `noeviction`, because an
evicted BullMQ job is silently lost work.

## Unified compliance webhook — adopted

Their `shopify.app.toml` registers all three GDPR topics against **one** endpoint:

```toml
[[webhooks.subscriptions]]
compliance_topics = [ "customers/data_request", "customers/redact", "shop/redact" ]
uri = "/webhooks/compliance"
```

with a single route switching on `topic`. That is simpler than three routes and one fewer
place to get HMAC handling wrong. Our `shopify.app.toml` has been updated to match.

Also worth copying from `webhooks.compliance.tsx`: it rejects non-`application/json`
Content-Type with a 400 before doing anything else, and relies on `authenticate.webhook()`
for HMAC verification.

## Billing shape (for P5.8)

`app/server/billing/` splits into `subscription.service.server.ts` and
`billing-cycle.server.ts`, driven by the `app_subscriptions/update` webhook, with
reconciliation routes (`api.subscriptions.sync`, `.process-expired`, `.cancel-pending`).

The reconciliation routes are the interesting part: webhooks alone were evidently not
enough to keep subscription state correct, so there is a sync path as well. Expect to need
the same — plan tier drives our surface gates, and a wrong tier either blocks a paying
merchant or gives away the Markets surface.

## Environment variables it uses

Ones relevant to us, beyond what `.env.example` already has: `ENCRYPTION_KEY` (we need this
for encrypting access tokens at rest, task P0.3), `SHOPIFY_APP_HANDLE`, `RAILWAY_PUBLIC_DOMAIN`,
`CRON_SECRET` (for authenticating scheduled HTTP triggers), `RESEND_API_KEY`, `FROM_EMAIL`.

## Pitfall to avoid

`app/shopify.server.ts` there declares the API version in **three places with three
different values** — `ApiVersion.April24` in the config, `restResources` imported from
`2024-10`, and an exported `apiVersion = ApiVersion.October24`.

This is exactly why [RFC-001 §12](rfc-001-architecture.md) requires the version pinned in
one module and imported everywhere. Treat it as a worked example of the failure mode, not a
pattern to copy.
