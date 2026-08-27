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

## Alert: webhooks more than five minutes behind

**Metric:** `webhook.lag_ms` — the largest `processedAt - receivedAt` across deliveries
processed in the last fifteen minutes.

**What it means.** Shopify reached us and we were slow to act on it, so the mirror is
behind the store. A campaign planned against a stale mirror prices the wrong products: a
variant created ten minutes ago is not in scope, and one that just moved collection is
scoped by where it used to be.

**Read the metric carefully.** It measures *our* processing, not Shopify's delivery, and
it is computed only over events that already have a `processedAt`. That has a consequence
worth knowing at 3am: **if the worker stops outright, nothing gets a `processedAt`, the
sample is empty, and this alert goes quiet instead of firing.** The same emptiness zeroes
the denominator behind *errors spiking*, which needs twenty deliveries before it will
speak. A worker that is dead rather than slow is caught by **scheduler tick stopped**, and
by that alert alone — so read sudden silence across all three as a stopped worker until
something proves otherwise.

**Diagnose.**

1. `SELECT status, count(*) FROM webhook_events WHERE "receivedAt" > now() - interval '1 hour' GROUP BY status;` — a large `RECEIVED` next to a small `PROCESSED` is a worker accepting deliveries and not draining them.
2. `SELECT topic, count(*), max(now() - "receivedAt") AS oldest FROM webhook_events WHERE "processedAt" IS NULL GROUP BY topic ORDER BY oldest DESC;` — one topic backed up while the others move points at that handler rather than at the worker.
3. `SELECT "failureReason", count(*) FROM webhook_events WHERE status = 'FAILED' AND "receivedAt" > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC;` — a repeated reason means the handler is throwing and `attempts` is climbing.

**Remediate.** If the queue is draining and merely slow, let it. Restarting mid-drain
costs the in-flight batch and buys nothing, because delivery is at-least-once and the
unique constraint on `webhookId` makes the replay safe rather than fast. If it is not
draining, restart the worker and watch `PROCESSED` climb. Once lag is back under a minute,
run a catalogue re-sync for any shop that ran a campaign during the window — the mirror
caught up, but anything planned against it while it was stale did not.

**Do not** clear the backlog by deleting rows. `webhook_events` is how a lost change is
found afterwards, and a mirror divergence with no delivery history is unexplainable.

---

## Alert: errors spiking

**Metric:** `error_events` in the last fifteen minutes over deliveries processed in the
same window, firing above 5% — and only once the window holds at least twenty deliveries,
so one failure on a quiet night is not a 33% error rate.

**What it means.** More than one in twenty is failing. Whatever it is, it is reaching
merchants now rather than one unlucky merchant. It says nothing yet about *what* is
failing; the first job is to find out whether this is one cause, one shop, or one route.

**Diagnose.** Start with the shape, not the stack.

1. `SELECT code, count(*) FROM error_events WHERE "createdAt" > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC;` — one code dominating is a single cause. A flat spread is usually infrastructure underneath all of them.
2. `SELECT "shopId", count(*) FROM error_events WHERE "createdAt" > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;` — concentrated on one shop is that shop's data or its rate-limit budget, and is not an outage.
3. `SELECT route, method, count(*) FROM error_events WHERE "createdAt" > now() - interval '1 hour' GROUP BY 1,2 ORDER BY 3 DESC;` — one route is a deploy; every route is the database or Shopify.
4. Pick one `errorId` and read its `message`, `stack` and `userMessage` together. `userMessage` is what the merchant was actually told, which decides whether this needs a status note as well as a fix.

**Remediate.** A dominant `SHOPIFY_UNAVAILABLE` is Shopify's, and the retry policy is
already handling it — confirm it recovers rather than acting. Anything correlated with a
release should be rolled back before it is diagnosed. If the errors are concentrated in
execution, check for runs stuck mid-flight before restarting anything: see
[Stuck run recovery](#stuck-run-recovery), because a restart with rows already in the
ledger and unsettled is the case that procedure exists for.

**Do not** raise the threshold to stop the paging. The 5% floor and the twenty-delivery
minimum are both there because the noisy versions of this alert were tried first.

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

## Alert: variants that cannot be priced

**Metric:** `mirror.unpriceable` · **Severity:** page

**What it means.** Live variants exist in `variant_index` with no `BASE` row in
`price_surface_entries`. Baselines are captured from the surface table, so those variants
cannot be baselined, and a variant with no baseline is silently skipped by every campaign.

The count is what the nightly audit **could not repair**. It heals what it can from the
index, so anything left is a variant whose index row has no price to heal from.

**Why it pages.** This is the failure mode where everything looks right. The variants are
mirrored, counted, and listed in the catalogue; the merchant sees them and includes them in
a campaign; the run reports success and quietly prices fewer products than they asked for.
It once affected an entire catalogue — the bulk import wrote `variant_index` and not
`price_surface_entries`, so every store large enough to use the bulk path could import
cleanly and price nothing (#252).

Note what it is *not*: divergence is the mirror disagreeing with **Shopify**. This is the
mirror disagreeing with **itself**, which the divergence check cannot see because the
mirror is perfectly accurate about what Shopify holds.

**Diagnose.**

1. Find them:

   ```sql
   SELECT vi."variantGid", vi."price", vi."currency"
   FROM variant_index vi
   WHERE vi."shopId" = $1 AND vi."deletedAt" IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM price_surface_entries pse
       WHERE pse."shopId" = vi."shopId" AND pse."variantGid" = vi."variantGid"
         AND pse."surfaceKind" = 'BASE' AND pse."priceListGid" = ''
     )
   LIMIT 50;
   ```

2. **If `price` is null on those rows**, the audit could not heal them because there was
   nothing to write — a surface row with a null price is the same dead end one table
   further along. A full re-sync is the remedy; the variants have no price in our mirror at
   all.

3. **If `price` is populated**, the audit should have healed them and did not. That is a
   bug in the healing path rather than in an import path, and the count will not fall on
   its own overnight.

**Remediate.** Re-sync the catalogue for the shop. Then re-run the audit and confirm the
count is zero — do not assume, because the whole character of this fault is looking fine.

**Then find the writer.** A non-zero count means some path wrote an index row without a
surface row. Six code paths write both, and the invariant only holds because each of them
does; the fix is in whichever one stopped, not in healing harder. `git log -S
"priceSurfaceEntry" -- app/services` is the fastest way to see which one changed.

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

## Watch: a shop's budget saturated

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
