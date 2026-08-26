# Wiring pricing into Shopify Flow

> **Not available yet.** The integration is built — triggers, actions and the extensions
> that declare them to Shopify — but it has not been released. If you open Flow today you
> will not find these. This page is here so you can see what is coming and tell us whether
> it is the right shape, not so you can set it up.

Anchor will add three triggers and three actions to Flow, so pricing can be part of the
automations you already have rather than something you remember to do separately.

## Triggers

Something happened, and Flow can react to it.

| Trigger | Fires when | Carries |
|---|---|---|
| Campaign started | A campaign begins applying prices | Campaign id, name, how many products |
| Campaign ended | A campaign's prices are reverted | Campaign id, name, outcome, how many reverted |
| Campaign held for drift | A campaign stopped because prices were changed outside the app | Campaign id, name, how many products |

**No trigger carries a price.** Ids, names and counts only. A payload passes through Flow
and into whatever you connected next — a Slack channel, a spreadsheet, someone else's API
— and prices should not travel that far without you deciding they should.

## Actions

Flow asks Anchor to do something.

| Action | What it does |
|---|---|
| Start a price campaign | Exactly what the Apply button does, including your guardrails and your plan's limits |
| End a price campaign | Reverts it. Works on every plan, including free |
| Capture baselines for a segment | Records today's prices as the new normal |

Each action does exactly what the equivalent button does. An action that could start a
campaign the app would have refused would be a way round every safety feature in it.

**Capturing baselines is refused while a campaign is running.** In the app you have to
type a confirmation to do that, because it records sale prices as normal prices and every
future discount then comes off the discounted number. An automation cannot read a warning,
so it is refused rather than confirmed on your behalf.

## A worked example

**"When stock of a product runs low, end the sale on it."**

1. **Trigger:** Shopify's *Inventory quantity changed*.
2. **Condition:** inventory quantity is less than 10.
3. **Action:** Anchor's *End a price campaign*, with the campaign ID from the campaign's page.

Prices revert, the ledger records it, and Anchor's *Campaign ended* trigger fires — so you
can chain a Slack message onto the same Flow if you want to be told.

## Another

**"Tell the team when a campaign is held because someone edited a price."**

1. **Trigger:** Anchor's *Campaign held for drift*.
2. **Action:** Slack's *Send message*, using the campaign name and the count of products.

This is the one worth setting up. A held campaign is waiting for a decision, and the sooner
somebody makes it the shorter the window where prices are neither the sale price nor the
normal one.

## Finding a campaign ID

Open the campaign in Anchor. The ID is in the address bar, after `/campaigns/`.
