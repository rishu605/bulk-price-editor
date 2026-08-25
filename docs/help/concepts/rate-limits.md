# How rate limits affect a run

Shopify limits how fast any app can talk to your store. When a campaign hits that limit,
this app slows down rather than failing.

## What you will see

A run taking longer than you expected, with the ledger still filling in. That is the
system working: the alternative is a run that fails halfway and leaves you to work out
which products changed.

## Why we do not just go faster

The limit is a bucket that refills at a fixed rate. Sending more requests when it is empty
gets them rejected, and repeatedly rejected requests make Shopify throttle the store
harder — so pushing makes the whole thing slower, not faster.

The app reads the remaining budget from Shopify's own response on every call rather than
assuming a number, because the limits differ by Shopify plan.

## Large catalogues

Above a few thousand products the app switches to Shopify's bulk operation API, which is
designed for exactly this and does not consume the same budget. You do not choose this —
the app picks the path and the preview tells you which one it will use and why.

## Nothing is lost

A throttled run is not a failed run. Every price is recorded before it is written, so a
run that is interrupted at any point is resumable and the ledger says exactly where it
got to.
