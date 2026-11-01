# A guardrail stopped the run

A guardrail is a floor no campaign may price below. When one blocks a run, the app refused
to write a price rather than writing one you would not have wanted.

## The three floors

- **Never price at or below cost** — needs a cost on the variant. Variants without one are skipped, which is why importing costs matters if you rely on this.
- **Minimum margin** — a percentage of the selling price.
- **Minimum price** — an absolute number, whatever the rule computes.

## What a campaign can set

The floors in Settings apply to every campaign. A campaign can also set its own, under
**Advanced** in its editor, or in the **Floors** card on its Overview tab once it exists:

- **Tighter floors.** Raise any of the three for this campaign only: a higher minimum price
  for a luxury line, say. The higher of the two always applies, so if Settings later goes
  higher than the campaign, Settings wins.
- **Lower floors, with a typed confirmation.** A clearance can go below the store's floors:
  a lower minimum, none at all, or prices below cost. Saving one asks you to type
  **loosen**, and the activity log records who typed it, what the floor was in Settings and
  what it became. The same applies to a campaign that is already running. Changing another
  field later does not ask again; taking the floor further down does.
- **Its own policy.** Choose clamp, skip or block for this campaign. It then keeps that
  choice, whatever Settings says. Left at "The store's setting", the campaign follows
  Settings, as below.

The fields start at the store's floors, so a campaign where you change nothing sets nothing
of its own and follows Settings.

A copy of a campaign keeps its floors, but not the confirmation for any below the store's.
The store's floors apply to the copy until you save its floors again with **loosen**
typed, and its Floors card says so.

A campaign's minimum price is in your store's currency. Like the one in Settings, it is not
applied to a market priced in another currency.

The editor's preview, the campaign's Preview tab and the Apply dialog all say which floors
apply, and whether they are the store's or the campaign's own.

## Why it stopped everything rather than skipping one product

That is a setting: *when a price would breach a floor*.

- **Clamp** raises the price to the floor and carries on. The default. A discount never
  raises a price above its normal price, though: where the floor is above that, the
  product is left alone, and the preview says why.
- **Skip** leaves that product alone and prices the rest.
- **Block** stops the whole campaign.

Block exists for the case where one product breaching a floor means the rule itself is
wrong — a misplaced decimal point in a percentage, say — and pricing the other forty
thousand products would be the actual disaster.

## Which campaigns the setting applies to

New campaigns, and every campaign that has not started yet: drafts, scheduled campaigns,
and finished ones you apply again. Change the setting and their previews follow it. A
campaign that chose its own policy keeps that one instead, started or not.

A campaign that is running keeps the policy it started with until it ends. That covers
campaigns that are applying, active, held, partly applied or reverting. Its prices are
already on your storefront, and changing the setting should not change what it does to
them. Its own policy can't be changed while it runs either. Under the setting, Settings
lists every campaign keeping a different policy: running ones, and ones that chose their
own. Revert a running one and apply it again to give it the new one.

The campaign's Overview tab, and the dialog that opens when you press Apply, show which
policy that campaign will use.

## Floors are checked after rounding

A rounding rule can push an otherwise-legal price under the line. Checking before rounding
would let that through, so the order is: compute, round, then check.

## What to do

The message names the product and the floor it breached. Either lower the floor in
Settings (or in the campaign's own floors, if it has any), exclude that product from the
campaign, or change the rule.

What else it offers depends on whether the campaign has started. One that has not, like a
draft or a scheduled campaign, follows the setting, so the message offers Clamp or Skip
instead of Block. One that has started keeps Block until it ends, and changing the setting
does not reach it. Its message says so, and offers what does: lower or remove the floor,
or revert the campaign and apply it again, so it starts under the setting as it is then.
If the setting is still Block, change it before you apply again. A campaign that chose
Block itself is told so: before it starts, choose clamp or skip in its Floors card. Once it
has started, revert it, choose again, and apply it again.

Sometimes what stops a campaign is another campaign's Block. Reverting a campaign hands its
products to the next campaign that covers them, and a running campaign with a higher
priority prices a product before yours does. If that other campaign started under Block and
its price breaches a floor, it stops the whole run. Neither the setting nor changing your
campaign reaches it. The message names that campaign, and what does reach it: lower or
remove the floor, or revert that campaign and apply it again.

If most of your catalogue has no cost, cost-based floors are protecting less than you
think — the Settings page shows what percentage of your variants have one.
