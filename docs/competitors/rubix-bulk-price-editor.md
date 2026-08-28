# RUBIX Bulk Price Editor — teardown

*Captured 29 Aug 2026 by walking the live app on `dartmode-labs.myshopify.com` (installed
on the free plan, so paid surfaces are visible but gated).*

| | |
|---|---|
| Vendor | Rubix House |
| App handle | `rubix-bulk-price-editor` (listing: `rubix-bulk-price-editor-1`) |
| Listing tagline | "Automate bulk price changes, discount market prices, schedule discount, & schedule flash sale easily" |
| In-app tagline | "Automate Bulk Edit Prices, Market Discounts, & Scheduled Sales" |
| Rating | 4.8★ / 130 reviews (88% five-star, 5% three-star, 2% one-star) |
| Built for Shopify | Yes |
| Launched | 27 Jul 2020 |
| Categories | Bulk editor · Discounts |
| Scopes granted | Products (view+edit), Discounts (view+edit), "Other data" |
| Shopify Functions | Declares a Discounts function |

Rubix is the *feature-comparable, trust-incomparable* competitor. It matches the checklist
— markets, cost, compare-at, scheduling, rollback, tags, discount codes — and then
documents its own compounding bug in the FAQ and warns you about it in the campaign editor.

## Vocabulary problem, stated first because it runs through everything

The same object is called four things: **task** (nav, list, most headings), **campaign**
("Select Campaign Type" modal), **job** ("Step 6: set job scheduling"), and **discount
task** (usage meter). The app's own Quick Start Guide uses "task" and "campaign" in
adjacent sentences. There is no consistent noun for the thing a merchant creates.

## The shape of the whole app

Nav: **Subscription Plans · FAQ & Support · Feature Request · Settings** — four items, and
they are all *meta*. Nothing in the nav is about prices. The product itself is one page
(`Home`) plus one editor (`CreateTask`).

Observed inconsistency: at one point the nav rendered as **Subscription Plans · Settings ·
Feature Request · Support · Recommended Apps** instead. The nav is not stable.

Content uses the **full admin width** (~1180px on a 1470px viewport), unlike NA's centred
~1010px column.

## Page 1 — Home

Four stacked blocks:

1. **"We need your feedback 😄"** — a dismissible banner asking for a rating, with five
   emoji buttons (🤢 😟 😐 😊 😍). It sits *above* the product, on first load, before the
   merchant has done anything.
2. **Quick Start Guide** (dismissible) — numbered instructions for the two task types.
   Notable lines, verbatim:
   - *"Before saving the task, check all the settings and ensure they are correct. You can
     check them in the **Task Summary** section."*
   - *"If the task has already been marked as **ACTIVE**, check whether the price shows
     correctly for the selected products."* ← **the merchant is asked to verify the write**
   - *"If you want to restore the original price, go to "Revert Task Setting" then click
     "Revert Now" button. **Deleting the task will not restore the original price**."*
   - *"To remove a discount, delete the corresponding discount task from the task list. DO
     NOT delete the discount directly from the Discounts section."*
3. **Usage Limits** — `Current Plan: FREE`; *Price Editor & Discount Manager* — "Free Plan
   Quota: 150 variants/month", "Tasks this month (August): 0/150 variants" with a progress
   bar; *Automatic & Discount Code (Shopify allows a maximum of 25 ACTIVE discounts at the
   same time)* — "Total Discount Limit: 2", "Discounts created: 0/2".
4. **Task list** — tabs `All | Active | Scheduled | Inactive`, with search, filter and sort
   icons. Empty state: "No tasks found" + `Create Task`.

## Page 2 — Create Task

`Create Task` opens a modal, **"Select Campaign Type"**, with two cards:

| Type | Copy |
|---|---|
| **Price Editor & Discount Manager** | "Modify product variant base prices and market-specific prices for your store. Also, you can show the **strike-through** price with this campaign type." |
| **Automatic & Discount Code** `New` | "Create discount codes or automatically applied in the cart and at checkout when eligibility conditions are met." + a worked use case + `0/2 total discounts used` |

The second type creates real Shopify automatic discounts / discount codes rather than
writing prices — a genuinely different mechanism, chosen at the top of the funnel.

### The editor: six steps, plus a live summary aside

Left column: six numbered cards. Right column: a sticky **Task Summary** that mirrors the
form as an eight-item numbered list (Task name · Selected markets · Selected products ·
Selected variants · Add Product Tags · Remove Product Tags · Price update method · Job
Scheduling), filling in as you go.

**The first thing in that aside is a warning, not a summary:**

> ⚠ Do not create a 2nd task that target the same products **without reverting** the 1st
> task, because it will mess up the price. Unless, you know what you are doing. Please read
> the **FAQ** to learn more.

#### Step 1: add task name
One empty text field. No prefill, no explanation of whether customers see it.

#### Step 2: choose the implementation method
- **Apply to the variant base price** ⓘ *(default)*
- **Apply fixed price to Markets (choosing by Catalogs)** ⓘ
- **Apply fixed price to Markets (choosing by Markets)** ⓘ

Choosing a markets method reveals a repeater: `Market Name [Anchor EU test ▾]`
`Revert Options ⓘ [Revert to fixed price (FIXED) ▾]` `[Add Market]`, with
*"Associated catalog: Anchor EU catalog"* underneath, and a paywall line:

> \*Please upgrade your plan to **SUPER DUPER COOL** to use this feature *here*

**Revert Options** is the one place Rubix acknowledges that reverting is a choice:
`Revert to fixed price (FIXED)` / `Revert to percentage-based price (RELATIVE)`.

#### Step 3: choose the products
`Specific Products` / `Specific Variants` / `Collections` / `Based on conditions or All
products`, followed by a **Product Preview** table with columns
`Product · Inventory · Product Type · Vendor`.

Note what that table shows: **inventory, type and vendor — not price.** There is no
before → after anywhere in the editor.

#### Step 3.1: choose the variants
"Variants must match:" a chip list seeded with `all_variants`, plus a select to add more.

#### Step 4: add/remove product tags (optional)
`Add Product Tags` ⓘ [input] `Add Tag` · `Remove Product Tags` ⓘ [input] `Add Tag`.

#### Step 5: set price or compare-at-price
Two radios:

**Price Editor (modify price and/or compare-at-price in general)**

| `Field to edit` | `Operation` |
|---|---|
| price | update to |
| compare-at-price | adjust by amount |
| price & compare-at-price | adjust by percentage |
| | adjust based on compare-at-price (by percentage) |
| | **set to specific gross margin** |

Then a value field labelled in prose — "update price to [ USD ]" — and an **EXAMPLE**
block:

> **Before updating the price to $30** · price: $10
> **After updating the price to $30** · price: $30

A generic illustration with invented numbers, not the merchant's data.

**Discount Manager (create sales campaign w/ strike-through pricing)**

- `Discount Value` [Discount Percentage ▾] [ __ % ]
- *What is compare-at-price?* link
- ☑ compare-at-price gets replaced by the original price (showing that your product is on **SALE**)
- ☑ **Do not modify products that are on SALE** ⓘ
- An **EXAMPLE** that renders a *mock storefront card* — "T-Shirt · 100.00" → "T-Shirt ·
  80.00 ~~100.00~~ `SALE`" — again with invented numbers
- **Rounding Options** [Default rounding ▾] with `Examples: Before: 15.638 || After: 15.64`

Rounding exists only in Discount Manager mode; the Price Editor path has none.

#### Step 6: set job scheduling
`Schedule Options: [--choose schedule option-- ▾]`. On the free plan the only value is
**One time schedule** — weekly scheduling is a SUPER COOL feature. Choosing it reveals:

| Set Start Date | Set Revert Date |
|---|---|
| I want to run the task right now *(default)* | I don't want to set the revert date *(default)* — *"you can still revert the task manually later"* |
| I want to run the task later | I want to set the revert date |

No timezone is stated anywhere.

#### There is no submit button
The page ends at Step 6 and the support footer. The only way to create the task is App
Bridge's contextual **Save**, 600px above at the top of the admin chrome. There is no
confirmation step, no summary modal, no "this will change N variants", no acknowledgement.

## Page 3 — Subscription Plans

A promo-code field, a `Monthly | Yearly ✨SAVE 25%✨` toggle, and four cards with joke
names:

| Plan | Price | Features |
|---|---|---|
| **FOREVER FREE PLAN** (current) | $0 | 150 product variants/month · 2 automatic discount tasks creation · Advance filters · Schedule start and revert |
| **COOL** | $7.95/mo | Unlimited Price Editing tasks · 10 automatic discount tasks · Advance filters · Schedule start and revert |
| **SUPER COOL** | $10.95/mo | + 20 automatic discount tasks · **Weekly Scheduling** · **Synchronize newly added products** |
| **SUPER DUPER COOL** | $14.95/mo | + Unlimited automatic discount tasks · **Market price editor** · **Cost editor** |

All paid plans: 3-day free trial. Yearly saves 25%.

Two features worth naming because we do not have them:
- **Weekly Scheduling** — the only recurrence any of the three apps offers.
- **Synchronize newly added products** — a product added *after* a campaign starts is
  picked up by it. Our resolver makes this natural; we do not expose it.

## Page 4 — Settings

One field: `Email Address` — *"This email will be used to send an update once the task has
been done"*. That is the whole settings surface.

## Page 5 — FAQ & Support

A seven-item accordion, then a **Contact us** form (Subject · Name · Email · **Task ID** ·
Message). The Task ID field tells you how often support needs to look up a specific run.

The questions are the most useful artefact in the whole teardown, because a FAQ is a list
of the things that go wrong often enough to pre-empt:

1. How the app works?
2. **How to avoid messing up the price?**
3. How to show the SALE price and strike-through the original price side by side?
4. **Why does the discount still appear although I've reverted the task?**
5. **Why do some products get discounted and some products don't?**
6. **Why do discounts suddenly disappear? Although I don't revert the discount through the app**
7. **Why does the compare-at-price (strike-through price) not appear in the Euro markets?**

### Question 2, in full — this is the competitive centre of gravity

> Do not create a 2nd task that target the same products **without reverting** the 1st
> task. Unless, you know what you are doing. Here is the simulation:
>
> - Create the first task (task 1): 30% discount campaign for "Nike Air Jordan"
>   - initial price: 1000 USD · initial compare-at-price: 0
>   - `===Apply 30% discount===` current price: 700 USD · current compare-at-price: 1000 USD
> - Create the second task (task 2): 50% discount campaign for "Nike Air Jordan" **without
>   reverting task 1**
>   - initial price: 700 USD · initial current compare-at-price: 1000 USD
>   - *this is the initial price for this product if you don't revert task 1*
>   - `===Apply 50% discount===` current price: 350 USD · current compare-at-price: 700 USD
>   - `===Revert task 2===` initial price: 700 USD · initial current compare-at-price: 1000 USD
>   - **when you revert task 2, it will not revert to the original one ($1000), instead it
>     will revert to the initial price of task 2.**
>
> **So, please revert the first task BEFORE create the second task if you want to modify
> the same products**

This is `CLAUDE.md` rule 1 and rule 6 written out as a support article by the vendor who
violates them. Their model has no baseline: "initial price" means "whatever the price
happened to be when this task started". A 30% sale followed by a 50% sale leaves the
product at $350 for ever unless the merchant reverts in exactly the reverse order.

Q6 — "Why do discounts suddenly disappear? Although I don't revert the discount through the
app" — is the same fault from the other end.

## Page 6 — Feature Request

A form: `Type of Feature` + `Description` ("please describe your need as clear as
possible"). A feedback inbox, not a roadmap.

## What they do that is worth copying

1. **The live summary aside.** A sticky "Task Summary" that fills in as the form is
   completed, so the merchant can read back what they built without scrolling. Better than
   NA's end-of-flow modal in one respect: it is visible *while* you are deciding.
2. **Campaign type chosen up front, in a modal.** "Price change" and "Shopify discount"
   are genuinely different mechanisms, and picking between them first keeps each form
   honest.
3. **Explicit revert semantics as a control** — FIXED vs RELATIVE — even though the
   implementation is weaker than ours.
4. **"Do not modify products that are on SALE"** as a first-class checkbox.
5. **"Synchronize newly added products"** — campaigns that stay true as the catalogue
   changes.
6. **Weekly scheduling** — the only recurrence in the category.
7. **A usage meter with a progress bar on the landing page**, so the plan limit is never a
   surprise at commit time.
8. **A Task ID field in the support form.** Cheap, and it makes every support thread
   start with the run.

## What is broken or weak

- **No preview of prices, anywhere.** The only preview is a table of matched products
  showing inventory, type and vendor. The merchant learns the new price by looking at the
  storefront afterwards — which the Quick Start Guide explicitly instructs them to do.
- **No confirmation step and no submit button in the form.** The commit is a Save button
  at the top of the window, far from the last thing you touched.
- **Compounding is documented, not fixed.** See Q2 above.
- **Vocabulary drift** — task / campaign / job / discount task.
- **A feedback-rating banner above the product on first run**, before the merchant has
  used anything.
- **No timezone shown** next to the schedule pickers.
- **Paywall messaging inside the form** ("upgrade your plan to SUPER DUPER COOL") rather
  than a state the form can be in.
- **A 500 error** on a mistyped in-app route, rendered as bare `Internal Server Error`
  monospace text with no navigation back.
