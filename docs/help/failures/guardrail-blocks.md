# A guardrail stopped the run

A guardrail is a floor no campaign may price below. When one blocks a run, the app refused
to write a price rather than writing one you would not have wanted.

## The three floors

- **Never price at or below cost** — needs a cost on the variant. Variants without one are skipped, which is why importing costs matters if you rely on this.
- **Minimum margin** — a percentage of the selling price.
- **Minimum price** — an absolute number, whatever the rule computes.

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
and finished ones you apply again. Change the setting and their previews follow it.

A campaign that is running keeps the policy it started with until it ends. That covers
campaigns that are applying, active, held, partly applied or reverting. Its prices are
already on your storefront, and changing the setting should not change what it does to
them. Under the setting, Settings lists every running campaign that is keeping a different
policy. Revert one and apply it again to give it the new one.

The campaign's Overview tab, and the dialog that opens when you press Apply, show which
policy that campaign will use.

## Floors are checked after rounding

A rounding rule can push an otherwise-legal price under the line. Checking before rounding
would let that through, so the order is: compute, round, then check.

## What to do

The message names the product and the floor it breached. Either lower the floor in
Settings, exclude that product from the campaign, or change the rule.

What else it offers depends on whether the campaign has started. One that has not, like a
draft or a scheduled campaign, follows the setting, so the message offers Clamp or Skip
instead of Block. One that has started keeps Block until it ends, and changing the setting
does not reach it. Its message says so, and offers what does: lower or remove the floor,
or revert the campaign and apply it again, so it starts under the setting as it is then.
If the setting is still Block, change it before you apply again.

Sometimes what stops a campaign is another campaign's Block. Reverting a campaign hands its
products to the next campaign that covers them, and a running campaign with a higher
priority prices a product before yours does. If that other campaign started under Block and
its price breaches a floor, it stops the whole run. Neither the setting nor changing your
campaign reaches it. The message names that campaign, and what does reach it: lower or
remove the floor, or revert that campaign and apply it again.

If most of your catalogue has no cost, cost-based floors are protecting less than you
think — the Settings page shows what percentage of your variants have one.
