# A run that seems stuck

A run showing "Applying…" for a long time is usually one of three things.

## It is genuinely still working

A campaign over a large catalogue takes minutes, sometimes longer. Shopify rate-limits per
store, and the app deliberately slows down rather than hammering — hammering gets the
store throttled harder and takes longer overall.

A campaign of more than 50 variants, and anything Shopify Flow starts or ends, is written by
the background worker rather than while the page waits, so you can leave the page and come
back. At the top of the campaign page, where the Apply button usually is, the run says where
it has got: **Queued** while it waits for the worker, **Planning** while it works out each
price, **Writing 1,200 of 4,000 prices** as it writes them, then **Verifying** while it reads
them back and adds tags and market prices. When it finishes the page says **Done** and shows
the result, without a reload.

While it writes prices, it also says when it started and how long it has left, for example
"Writing 1,200 of 4,000 prices · Started 14:02 · about 4 minutes left". The time left appears
once a twentieth of the prices are written, and keeps itself up to date. It goes away while
the run adds tags and market prices, which come after the prices and are not in that count.
It also goes away if the run has not been heard from for a minute.

A large campaign is handed to Shopify to write in the background, as one operation, and its
prices are confirmed together when Shopify finishes. There is no time left to show for one.
The Runs tab says how many prices were sent to Shopify, when, and how far Shopify has got.

The ledger fills in once the prices are written and read back, all at once rather than row
by row. A ledger that has not moved yet does not mean anything is wrong.

## Shopify is rate-limiting

Normal on a big run. The app backs off and continues; nothing is lost and nothing is
half-written. There is nothing to do.

## The process running it stopped

Rare, but it happens — a deploy, a restart, an out-of-memory. The app detects this: a run
that stops reporting for five minutes is reclaimed automatically, marked **partial**, and
becomes resumable. A run still **Queued** is not one of these: nothing has started, and it
starts on its own once the worker is back.

You do not need to do anything to trigger that, and you should not try to force it. A run
that is merely slow, reclaimed early, would be two processes believing they own the same
work.

## What never happens

A stuck run does not leave prices half-written in a way nobody can see. Every price we
write is recorded before we write it, so however a run ends, the ledger says what is live.
