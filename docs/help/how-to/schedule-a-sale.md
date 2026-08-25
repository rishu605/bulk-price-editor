# Scheduling a sale

Set a start, optionally an end, and the app runs it.

## Times are your store's

Everything is shown and entered in your store's timezone, which the app displays on every
scheduling field so it is never a guess.

## The revert buffer

A sale ending at midnight starts reverting slightly *before* midnight — five minutes by
default.

That is deliberate. Writing prices across a large catalogue takes time, and starting the
revert exactly at the advertised end leaves sale prices live for minutes after the sale is
over. Merchants get complaints about that, and they are right to.

Adjust the buffer per campaign if your catalogue is large enough to need longer.

## What happens if the app is down at the moment it should start

It starts when the app recovers. Scheduled runs are due-based, not moment-based: the
scheduler asks "what should have started by now", not "what starts exactly now".

The same applies to reverts, which is the more important half.

## Seeing it in context

The **calendar** shows every scheduled campaign, which ones overlap, and how many products
they share. Clicking a day opens the wizard already dated to it.
