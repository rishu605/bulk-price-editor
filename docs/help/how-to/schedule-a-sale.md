# Scheduling a sale

Set a start, optionally an end, and the app runs it.

## Times are your store's

Everything is shown and entered in your store's timezone, which the app displays on every
scheduling field so it is never a guess.

That is the time zone in your Shopify settings (**Settings > General**), read from Shopify
when you open the app and again when you save a schedule. If Shopify can't be asked just
then, the campaign editor says so and won't take a date until it can.

If you change your store's time zone in Shopify, nothing you scheduled moves by itself, but
a sale set for 9:00 may now fall at a different time on your new clock. Home lists each
campaign that does, and its page lets you choose: keep the time you set, now on your new
clock, or keep the new time.

## Large or deep sales are confirmed when you schedule them

When a campaign writes more prices, or moves a price further, than your typed-confirmation
settings allow (**Settings**, 1,000 prices and 50% unless you changed them), the Apply button
asks you to type *apply*. The scheduler starts a sale with nobody there to ask, so the
question comes when you save the dates instead, and again when you change them if the sale
has grown since. Your
confirmation is kept with the campaign: who gave it, when, and what the sale reached then.

When the start comes, the sale runs if it still reaches no further than that: no more than a
tenth more prices, and no price moved further than the largest change you confirmed. A sale
whose scope has grown past that, because its segment was edited or products were added, is
not started. The campaign reads **Scheduled — couldn't start**, says what grew, and you get one
email. Move its dates and type *apply* when asked, or apply it by hand.

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
