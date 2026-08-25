# Runbooks

One page per alert: what it means, how to tell what is actually happening, and what to do
about it. Written to be read at 3am by somebody who did not build this.

The first question in every incident here is the same one, so it is worth stating once:
**the ledger is the record of what we did to a merchant's storefront.** `variant_changes`
holds one row per variant per surface per run, written *before* the API call and settled
after it. If you want to know what is live and why, that table and the reconciliation view
over it are the answer — not the logs, and not a guess from the campaign's status.

---

## Alert: mirror divergence above 0.5%

**Metric:** `mirror.divergence_rate`

**What it means.** The nightly audit fresh-read a sample of variants from Shopify and more
than one in two hundred disagreed with what we hold. Incidental divergence is expected —
a webhook lost in flight, an edit during the sample. A rate this high is systematic: the
pipeline is losing changes rather than dropping the occasional one.

**Diagnose.**

1. `SELECT * FROM error_events WHERE "createdAt" > now() - interval '24 hours' ORDER BY "createdAt" DESC LIMIT 50;` — a burst of `SHOPIFY_UNAVAILABLE` around the divergence explains it and needs no action beyond confirming it recovered.
2. Check webhook delivery in the Partner dashboard. Sustained failures mean Shopify has been unable to reach us; the mirror will be stale until a full re-sync.
3. `SELECT status, count(*) FROM webhook_events WHERE "receivedAt" > now() - interval '24 hours' GROUP BY status;` — a large PENDING count means we are accepting deliveries and not processing them, which is a worker problem rather than a Shopify one.

**Remediate.** The audit heals what it samples, so the immediate divergence is already
corrected. For the rest, trigger a catalogue re-sync from the dashboard. It is a bulk
operation and takes minutes, not seconds, on a large store.

**Do not** turn the alert threshold up. It is set where it is because a rate above it has
always meant something real.

---

## Alert: scheduler tick stopped

**Metric:** `scheduler.tick` absent for more than three intervals

**What it means.** No worker is holding the leader lock and ticking. Scheduled campaigns
are not starting and, more importantly, **scheduled reverts are not running** — every
minute of this is a minute a sale runs past its end.

**Diagnose.**

1. Is the worker process alive? A crash loop shows as repeated startup lines with no ticks between.
2. Is Redis reachable? The leader lock lives there. Without it no worker will consider itself leader, and the process stays up while doing nothing — which is why this alert exists rather than a process-liveness one.
3. `SELECT id, status, "startedAt", "heartbeatAt" FROM campaign_runs WHERE status NOT IN ('COMPLETED','FAILED','PARTIAL');` — runs stuck in EXECUTING with an old heartbeat confirm the worker died mid-run.

**Remediate.** Restart the worker. The reaper reclaims stale runs on the next tick and
marks them PARTIAL, which is resumable and visible to the merchant. Nothing needs manual
database editing.

**Escalate** if the lock is held by a worker that is alive but not ticking — that is a bug
worth waking somebody for, because the lock will not expire while it is being renewed.

---

## Alert: queue depth rising

**Metric:** `queue.depth`, per queue

**What it means.** Jobs are arriving faster than they are draining. Which queue matters
enormously: `audit` backing up is cosmetic, `execution` backing up means merchant
campaigns are late.

**Diagnose.** Depth alone is not the signal — a bulk import legitimately enqueues a lot.
Look at whether the floor is rising over hours. Compare against `queue.failed`: a queue
that is failing every attempt looks like a backlog and is not one.

**Remediate.** Add worker replicas; queue consumers start with the process, so a second
worker drains immediately without any leadership change. If one queue is stuck behind a
single poison job, its failure is in `error_events` with the job id.

---

## Alert: a shop's budget saturated

**Metric:** `budget.saturation`

**What it means.** A shop's Shopify rate-limit bucket is near empty and the executor is
backing off. This is normal during a large campaign and is not by itself a problem — the
budget manager exists to make it survivable.

**It becomes a problem** when saturation is sustained while `run.duration_ms` climbs on a
small campaign, which suggests we are competing with something else on that shop rather
than simply being busy.

**Remediate.** Nothing, usually. Do not raise concurrency to "get through it faster" —
that makes it worse, because two workers on one shop each back off from the other.

---

## Stuck run recovery

A run that will not finish is almost always one whose process died. The reaper handles
this automatically after `RUN_STALE_AFTER_MS` (default five minutes), so **the first
action is to wait one tick and look again.**

If it is genuinely stuck:

1. Find it: `SELECT id, "campaignId", status, "heartbeatAt" FROM campaign_runs WHERE status IN ('EXECUTING','VERIFYING') ORDER BY "startedAt";`
2. Read what it actually did: the campaign page's ledger, or `SELECT status, count(*) FROM variant_changes WHERE "runId" = '<id>' GROUP BY status;`
3. Let the reaper have it. Marking it PARTIAL by hand is the same thing the reaper does, and doing it manually risks marking a run that is merely slow.

**Never** delete `variant_changes` rows to "clean up" a stuck run. Those rows are how a
revert knows what to undo; deleting them strands the merchant's prices with no record of
how they got there.

**Resume** from the campaign page. A resumed run reads the ledger and continues from the
rows that never settled — it does not replan.

---

## Data restore

**Objective:** RPO ≤ 5 minutes, RTO ≤ 1 hour.

What actually needs restoring, in order of how badly it hurts to lose:

1. **`variant_changes` and `baselines`.** The ledger and the reference prices. Losing baselines means every campaign computes from the wrong number for ever after; losing the ledger means no revert can be trusted.
2. **`campaigns` and `campaign_runs`.** Recoverable in principle from the ledger, painfully.
3. **The mirror** (`variant_index`, `price_surface_entries`). Rebuildable from Shopify with a full sync. Slow but not lossy.
4. **Sessions.** Rebuildable by reinstalling, at the cost of every merchant reinstalling.

**Procedure.**

1. Stop the worker first. A worker writing prices against a half-restored database is worse than an hour of downtime.
2. Restore Postgres to the target point in time.
3. `npm run setup` to apply any migrations the restored snapshot predates.
4. Run the reconciliation spot check at a large sample *before* starting the worker. If the mirror disagrees with Shopify, sync before scheduling anything — a campaign planned against a stale mirror prices the wrong products.
5. Start the worker. Reclaim happens on the first tick.

**Rehearse this, do not assume it.** The numbers above are objectives until somebody has
timed them against a real snapshot.

---

## On-call expectations

- **Page-worthy:** scheduler tick stopped, execution queue depth rising for over an hour, mirror divergence above 0.5%. All three mean merchant prices are wrong or about to be.
- **Next business day:** audit queue backlog, budget saturation, individual run failures. The app is designed so these are visible and resumable rather than urgent.
- **Never page for:** a single failed variant, a guardrail block, a drift hold. Those are the product working.
