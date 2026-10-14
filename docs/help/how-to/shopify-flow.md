# Wiring pricing into Shopify Flow

Anchor adds three triggers and three actions to Flow, so pricing can be part of the
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

| Action | What it does | Asks for |
|---|---|---|
| Start a price campaign | Exactly what the Apply button does, including your guardrails and your plan's limits | The campaign's ID |
| End a price campaign | Reverts it. Works on every plan, including free | The campaign's ID |
| Capture baselines for a segment | Records today's prices as the new normal | The segment's ID |

Where to find each ID is at the end of this page.

Each action does exactly what the equivalent button does. An action that could start a
campaign the app would have refused would be a way round every safety feature in it.

**Capturing baselines is refused while any campaign's prices may be on your store** —
running, on hold after a price was edited elsewhere, part-applied, or part-way through
ending. In the app you have to type a confirmation to do that, because it records sale
prices as normal prices and every future discount then comes off the discounted number. An
automation cannot read a warning, so it is refused rather than confirmed on your behalf.

## A worked example

**"When stock of a product runs low, end the sale on it."**

1. **Trigger:** Shopify's *Inventory quantity changed*.
2. **Condition:** inventory quantity is less than 10.
3. **Action:** Anchor's *End a price campaign*, with the campaign's ID pasted into its
   **Campaign ID** field.

Prices revert, the ledger records it, and Anchor's *Campaign ended* trigger fires — so you
can chain a Slack message onto the same Flow if you want to be told.

## Another worked example

**"Tell the team when a campaign is held because someone edited a price."**

1. **Trigger:** Anchor's *Campaign held for drift*.
2. **Action:** Slack's *Send message*, using the campaign name and the count of products.

This is the one worth setting up. A held campaign is waiting for a decision, and the sooner
somebody makes it the shorter the window where prices are neither the sale price nor the
normal one.

## Finding a campaign or segment ID

Each ID is shown in Anchor with a clipboard button beside it that copies it.

**A campaign's ID.** Open **Campaigns** and click the campaign's name. Its page opens on
the **Overview** tab. At the foot of that tab, below **New products**, is the line
*Campaign ID, used in Shopify Flow*, with the ID under it. Press the clipboard button
beside the ID, then paste it into the action's **Campaign ID** field. A practice campaign
has no ID there, because Flow cannot start a practice campaign.

**A segment's ID.** Open **Settings**, then the **Segments** tab. In the **Your segments**
table, each segment's ID is the grey line under its name, with the same clipboard button
beside it. Paste it into the **Segment ID** field of *Capture baselines for a segment*.

If the browser blocks the copy, Anchor says so. Select the ID and copy it with Ctrl+C, or
⌘C on a Mac.

<!-- TODO(#826): screenshots of both places, cropped as docs/help/images/README.md says:
     the foot of a campaign's Overview tab showing "Campaign ID, used in Shopify Flow",
     and Settings > Segments showing an ID under a segment's name. Put them under each
     paragraph above, with alt text that describes what they show. -->
