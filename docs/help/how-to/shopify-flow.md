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
| End a price campaign | Reverts it, leaving any price edited outside Anchor as edited. Works on every plan, including free | The campaign's ID |
| Capture baselines for a segment | Records today's prices as the new normal | The segment's ID |

Where to find each ID is at the end of this page.

Each action does what the equivalent button does, with one difference, below. An action
that could start a campaign the app would have refused would be a way round every safety
feature in it.

**Every action runs in the background.** Flow waits ten seconds for an answer, so Anchor
checks what it can at once and hands the rest to its background worker, however small the
campaign. Flow's run log says the action is under way within a second, and the campaign's
page shows it as it goes. A request Anchor refuses before it starts (a practice campaign,
one waiting for approval, one nobody confirmed, a capture while a sale is live) is a failure
in Flow's run log. One only the run itself can find, such as a guardrail set to block the
whole campaign, is said on the campaign's page and in the campaigns list once the worker
reaches it.

**Ending a campaign never writes over a price somebody edited outside Anchor.** When one of
a campaign's prices has been changed in Shopify since the campaign set it, the Revert button
doesn't revert straight away. It asks you to review the edits first, on the campaign's
**Revert** tab, and tick the ones to keep. Flow can't tick anything, so *End a price campaign*
keeps every edit: each edited price stays as it is, and every other price reverts. That
includes the edit that put a campaign on hold, and one you chose to leave for now in
**Prices → Price drift**.

Flow's run log says the edits will be kept. How many were is in the campaign's
**How it got here** history once the end finishes. The campaign's **Ledger** tab lists each kept
price, with why it was left. An edit still waiting in **Price drift** stays there for you to
decide. If you want an edited price reverted too, end the campaign with its Revert button
instead, and leave that edit unticked.

If the end stops part-way, Flow's run log says to resume it from the campaign page. **Resume**
finishes the revert and keeps the same edits: the banner above it says how many.

**A large or deep campaign has to be confirmed before Flow can start it.** When a campaign
writes more prices, or moves a price further, than your typed-confirmation settings allow,
the Apply button asks you to type *apply*. Flow cannot type it, so a start that needs it is
refused, and Flow's run log says why. Open the campaign's **Overview** tab and, under
**Scheduled and Flow starts**, type *apply* to confirm the campaign as it is now. Flow can then
start it for as long as it reaches no further than what you confirmed: no more than a tenth
more prices, and no price moved further than the largest change you saw. If it grows past
that, Flow is refused again until you confirm it again.

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

You can also end the sale from this trigger, with *End a price campaign* as the action. Every
price reverts except the edited one that held the campaign. That one stays as it was edited,
and waits in **Price drift** for you to decide.

## Finding a campaign or segment ID

Each ID is shown in Anchor with a clipboard button beside it that copies it.

**A campaign's ID.** Open **Campaigns** and click the campaign's name. Its page opens on
the **Overview** tab. At the foot of that tab, below **New products**, is the line
*Campaign ID, used in Shopify Flow*, with the ID under it. Press the clipboard button
beside the ID, then paste it into the action's **Campaign ID** field. A practice campaign
has no ID there, because Flow cannot start a practice campaign.

![The foot of a campaign's Overview tab: below the "New products" card, a card headed "Campaign ID, used in Shopify Flow" shows the campaign's ID with a clipboard button beside it, and the line "Paste it into Anchor's Start a price campaign or End a price campaign action."](../images/flow-campaign-id.png)

**A segment's ID.** Open **Settings**, then the **Segments** tab. In the **Your segments**
table, each segment's ID is the grey line under its name, with the same clipboard button
beside it. Paste it into the **Segment ID** field of *Capture baselines for a segment*.

![Settings, Segments tab: the "Your segments" table, explaining that Shopify Flow's Capture baselines for a segment action asks for a segment's ID. Each row shows a segment's name with its ID in grey underneath and a clipboard button beside it, then its kind, variant count, the campaigns using it, and Edit and Delete buttons.](../images/flow-segment-id.png)

If the browser blocks the copy, Anchor says so. Select the ID and copy it with Ctrl+C, or
⌘C on a Mac.
