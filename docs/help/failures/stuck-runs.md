# A run that seems stuck

A run showing "Applying…" for a long time is usually one of three things.

## It is genuinely still working

A campaign over a large catalogue takes minutes, sometimes longer. Shopify rate-limits per
store, and the app deliberately slows down rather than hammering — hammering gets the
store throttled harder and takes longer overall.

The ledger updates as it goes. If verified rows are still climbing, it is working.

## Shopify is rate-limiting

Normal on a big run. The app backs off and continues; nothing is lost and nothing is
half-written. There is nothing to do.

## The process running it stopped

Rare, but it happens — a deploy, a restart, an out-of-memory. The app detects this: a run
that stops reporting for five minutes is reclaimed automatically, marked **partial**, and
becomes resumable.

You do not need to do anything to trigger that, and you should not try to force it. A run
that is merely slow, reclaimed early, would be two processes believing they own the same
work.

## What never happens

A stuck run does not leave prices half-written in a way nobody can see. Every price we
write is recorded before we write it, so however a run ends, the ledger says what is live.
