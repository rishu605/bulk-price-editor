# A guardrail stopped the run

A guardrail is a floor no campaign may price below. When one blocks a run, the app refused
to write a price rather than writing one you would not have wanted.

## The three floors

- **Never price at or below cost** — needs a cost on the variant. Variants without one are skipped, which is why importing costs matters if you rely on this.
- **Minimum margin** — a percentage of the selling price.
- **Minimum price** — an absolute number, whatever the rule computes.

## Why it stopped everything rather than skipping one product

That is a setting: *when a price would breach a floor*.

- **Clamp** raises the price to the floor and carries on. The default.
- **Skip** leaves that product alone and prices the rest.
- **Block** stops the whole campaign.

Block exists for the case where one product breaching a floor means the rule itself is
wrong — a misplaced decimal point in a percentage, say — and pricing the other forty
thousand products would be the actual disaster.

## Floors are checked after rounding

A rounding rule can push an otherwise-legal price under the line. Checking before rounding
would let that through, so the order is: compute, round, then check.

## What to do

The message names the product and the floor it breached. Either lower the floor in
Settings, exclude that product from the campaign, or change the rule.

If most of your catalogue has no cost, cost-based floors are protecting less than you
think — the Settings page shows what percentage of your variants have one.
