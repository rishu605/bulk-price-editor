# NA Bulk Price Editor — teardown

*Captured 29 Aug 2026 by walking the live app on `dartmode-labs.myshopify.com`.*

| | |
|---|---|
| Vendor | Northern Apps (Courtenay, BC) |
| App handle | `price-scheduler-plus` — the handle is older than the name |
| Host | `price-scheduler.northern-apps.com` |
| Listing | "Easy bulk price edits, flash sales, and scheduled sales" |
| Rating | 4.9★ / 227 reviews (93% five-star, 3% one-star) |
| Built for Shopify | Yes |
| Launched | 27 Oct 2020 |
| Categories | Pricing optimization · Bulk editor |
| Scopes granted | Products (view+edit), Discounts (view+edit), "Other data" |
| Shopify Functions | Declares a Discounts function (0 active until a job blocks discount codes) |

This is the app to beat. It is the only one of the three that reads as a *designed*
product rather than a form over an API.

## The shape of the whole app

**Two nav items.** `Settings` and `Plans`. The app root redirects to `/jobs`. Everything
else — creating, previewing, scheduling, reverting, auditing — happens on two page
templates: the jobs list and the job page.

**One page template does create *and* read.** `/jobs/new` and `/jobs/:id` are the same
five-section form. On a finished job every control is rendered disabled, a status banner
is prepended, and two labels change ("Price change preview" → "Price change recap", `→`
→ `↺`). A merchant who has created one job can read any job, because it is the same
page.

**Contextual save bar.** App Bridge's "Unsaved changes · Discard · Save" owns the top of
the admin chrome while a job is dirty. Navigating away is intercepted by the browser's
own "Leave site?" dialog.

## Page 1 — `/jobs` (the landing page)

Three summary cards across the top, then a filtered list:

- **Scheduled jobs** — "No scheduled jobs upcoming"
- **Draft jobs** — "No jobs saved as drafts"
- **Need help?** — "Read docs on common questions" + `Read FAQs`

Then a search box, an `Add filter +` control, and the job list. Each row is four columns:
title · a plain-English sentence ("This job ran on 27 August 2026. This job was reverted
on 29 August 2026.") · a status badge · a one-line description of the change ("20% off
sale on 1 product variant").

`Add filter +` offers exactly **one** dimension: **Job status**, with values
`Pending · Queued · In progress · Complete · Reverting · Reverted`.

> **Note what is missing from that list: there is no failed, partial or errored state.**
> A job either completes or it does not exist. This is the single biggest structural
> difference from us and it is not a small one — see the comparison doc.

Primary action, top right: **`Add new price change job`**.

## Page 2 — `/jobs/new` (create) and `/jobs/:id` (read)

Five numbered sections on **one scrolling page**. Not a wizard — no back/next, no step
indicator, everything visible at once. One `Continue` button at the foot.

### Step 1. "Optionally give your price change job a title (eg "March 30% off sale on boots")"

A single text field, **pre-filled** with `29 Aug 2026, 03:46:58 Price change job`.
Helper text: *"This title is just for internal use, customers won't see it"*.

Two decisions worth stealing: the field is pre-filled so it is never a blocker, and the
helper answers the question a merchant actually has (will my customers see this?).

### Step 2. "Select how the prices should change"

Four radios — **and CSV is one of them, not a separate route**:

1. **Create sale** (default)
2. **Use bulk price change rules**
3. **Set product prices individually**
4. **Use CSV upload**

Selecting a radio swaps the panel *below* it. To the right of the panel sits a
**`STOREFRONT EXAMPLE`** card: one real product from the shop, before → after, rendered
as the storefront would render it (`$759.96` `~~$949.95~~`). It updates as you type.

#### 2a. Create sale
- `Sale discount percentage` — one number field with a `%` suffix
- `Show rounding options` — collapsed checkbox
- `How are sale prices calculated?` link

Expanding rounding reveals two radio groups:

| Rounding | Rounding direction |
|---|---|
| Round to nearest .01 *(default)* | Round up or down (whatever is closest) *(default)* |
| Round to nearest whole number | Always round up |
| End prices in .99 | Always round down |
| End prices in a certain number | |
| Round prices to a certain multiple | |

#### 2b. Use bulk price change rules
Two stacked cards, **Price** and **Compare at price**, each a `Change type` dropdown with
an ⓘ. The price card adds a value field and the same rounding checkbox.

**Price change types (8):**
1. Increase the price by an amount
2. Increase the price by a percentage
3. Decrease the price by an amount
4. Decrease the price by a percentage *(default)*
5. Set the price to a fixed amount
6. Set the price to a percentage of the compare at price
7. **Set the price to a certain margin** ← cost/margin pricing lives here
8. Don't change the price

**Compare-at change types (6+):**
1. Change the compare at price to the current price (sale) *(default)*
2. Increase the compare at price by a percentage
3. Increase the compare at price by an amount
4. Decrease the compare at price by a percentage
5. Decrease the compare at price by an amount
6. Remove the compare at price
7. Don't change the compare at price

Choosing "Don't change the price" **removes** the value field and the rounding checkbox
from the card. The form shrinks to fit the choice.

#### 2c. Set product prices individually
Step 2 renders **no panel at all**. Instead the preview list further down becomes
editable: each "after" card grows a `Price` and `Compare at price` money input, two icon
buttons, and an `Unedited` badge. The preview *is* the editor.

#### 2d. Use CSV upload
A drop zone with `Add files`, then `Get CSV template` and a `CSV upload FAQ` link.
**Step 3 (product selection) disappears entirely** and the remaining steps renumber —
the file defines the scope, so asking for a scope would be a contradiction.

### Step 3. "Select which products should change in price"

Sub-label: *"Select all products, use filters, or select products variants individually"*

1. **All products** (default)
2. **Filter by product, collection, tag, vendor, product type, variant title, or inventory**
3. **Select product variants individually**

Option 2 opens a condition builder: `Products must match: ( ) all conditions (•) any
condition`, then rows of `[The product ▾] [Is equal to ▾] [value]` with `Add another
condition`.

Below the radios, always: **`Price change preview`** with an ⓘ.

> `Over 250 product variants would be affected by this price change:`
> — or, once filtered — `1 product variant would be affected by this price change:`

A paginated two-column list of before → after cards with thumbnails, a sort toggle, and a
**`Full Preview`** button. It recomputes live as the rule or the scope changes. On a
completed job the same block is titled **`Price change recap`** and reads
`1 product variant was affected by this price change:`.

### Step 4. "Select when the prices should change"

Left: `Change prices now` / `Change prices later`.
Right, independent: `☐ Revert to original prices later?`

Choosing "later" or ticking "revert" reveals **two side-by-side date+time pickers with
inline month calendars**, defaulted to tomorrow and a week after that. Under them:

> *Dates and times shown above use **Asia/Calcutta** as the timezone, where the current
> time is **03:50***

**There is no recurrence.** No "every Friday", no repeat, no campaign that runs again.
One start, one optional revert.

### Step 5. "Advanced settings (optional)"

Four checkboxes, all **off by default, all collapsed**. This is the pressure valve that
keeps the other four steps short.

| Checkbox | What it reveals |
|---|---|
| Add tags while price change job is active | A tag input, pre-seeded with a `price-change-job-active` chip, + *"How does tagging work?"* |
| Remove tags while price change is active | A tag input |
| Block discount codes on carts that contain any affected product | *"How does discount code blocking work?"* — this is what the Shopify Function is for |
| Show advanced sale price calculation options | `If an item is already on sale`: **Replace the current discount with the selected percent off** *(default)* / **Apply the selected percent off on top of the current sale price** |

The last one only appears in "Create sale" mode. In "Set prices individually" mode it is
absent — it would be meaningless.

### Validation

`Continue` with problems produces a red banner at the top of the page —
*"There are 2 errors with this price change job"* — listing every problem as a bullet
("A price change job must change at least 1 product variant", "Remove tags checkbox is
checked but no tags have been selected"), **and** an inline error under the offending
field (*"Enter at least 1 tag"*). Summary and inline, both.

### The confirmation modal

`Continue` on a valid job opens **"Price change job confirmation"** — a definition list
in plain English:

| | |
|---|---|
| Sale | 20% off |
| Scheduling | This job is scheduled to start on 30 August 2026. This job is scheduled to revert on 5 September 2026. |
| Product variants affected | 1 |
| Tags to add | price-change-job-active |
| Discount codes | All carts that contain any affected product will have all discount codes blocked |

Then, below the rule:

- **"A price change job like this usually takes a minute or less to complete."** ← a
  duration estimate, sized to the job
- **Important** — "An email will be sent to `rishu605@gmail.com` when the job has
  completed." / "You can update your confirmation email address from your Settings."
- A **required acknowledgement checkbox** gating `Confirm`: *"I understand that this
  price change job will block discount codes for all items in the cart when the carts
  contains any affected item"* — it appears only because discount blocking is on.

## Page 3 — a finished job

Header: title · status badge (`Reverted`) · `Copy to new job` · `Export Recap CSV` ·
`Delete job`.

Banner: green ✓ **"Prices reverted successfully"**, then *"The prices have been reverted
to their original values."* and, in italics, *"This job cannot be edited because it has
already completed."*

Below that, the whole five-step form again, disabled, with the recap in place of the
preview. `Copy to new job` is how you repeat a sale — **their substitute for
recurrence**.

## Page 4 — `/settings`

The entire settings surface is one short page:

- A card: `Member since 17 Aug 2026` · `Current plan: Free` + `See plans` ·
  `August usage 1/100 (1%)`
- **Notification details** → a single `Email` field. *"This information will be used to
  send you updates on your price change jobs."*
- **Advanced settings** → one checkbox:
  > ☐ **Change market prices in price change jobs**
  > When enabled, you can pick which Shopify markets to apply price changes to.
  > *Only needed for stores that require regional, B2B, or POS specific pricing*
  > Learn about the *Shopify markets feature*

**This is the most important single design decision in the app.** The entire
markets/B2B/POS surface — the thing that makes multi-market pricing hard — is behind one
off-by-default checkbox, with a sentence telling you whether it is for you. A
single-market merchant never sees the word "market" anywhere in the product.

Turning it on inserts a new **Step 4. Shopify markets** into the job form:

> ☑ Select Shopify markets to apply price changes to
> Apply price changes to:
> **Regions**
> ☐ Anchor EU test ☐ Anchor JP test ☐ Canada ☐ United States
> ☑ **Also change base prices** *What does this mean?*
> Learn about *Shopify market prices*

Steps renumber from five to six. B2B and POS catalogues appear as further groups on plans
that include them.

## Page 5 — `/plans`

> Whether you sell thousands of products or just a few - we have a plan that will help
> your business grow 🚀
> As a first time customer, you qualify for a 14 day FREE trial on all upgraded plans 🎉

| Plan | Price | Limit |
|---|---|---|
| **Free** (active) | $0 | Change the price of up to **100** product variants per month |
| Basic | $9.95/mo | up to **1,000** per month |
| Standard | $14.95/mo | up to **10,000** per month |
| Unlimited | $19.95/mo | **Unlimited** price changes |
| Unlimited Pro | $49.95/mo | Unlimited + **Change B2B market prices** + **Change POS market prices** |

`Pay Monthly ▾` toggle, *"Switch to yearly to save 16%"*. Footer:
*"Learn more about how our usage limits work"* and *"Don't see a plan that works for
you? Email us directly at chris@northern-apps.com and ask about special pricing for new
businesses"*.

**The meter is price changes per month** — the model D3 in `docs/decisions.md`
deliberately rejected. Markets are free; **B2B and POS pricing is the $49.95 gate**.

## What they do that we should copy

1. **CSV is a radio option, not a destination.** It sits fourth in "how should prices
   change", alongside percentage and rules. We made it a route (and then a section, and
   then dissolved the section).
2. **A named "Advanced settings (optional)" bucket.** Everything rare, collapsed,
   off by default, in one place at the end. Our rare options became nav items because we
   never built this.
3. **`STOREFRONT EXAMPLE` beside the control.** One product, before → after, in
   storefront rendering, updating as you type — *plus* the full list below. We have the
   list; we do not have the one-product example next to the input.
4. **Steps that renumber.** Pick CSV and the scope step vanishes. Pick "don't change the
   price" and the amount field vanishes. The form is only ever as long as the choice
   requires.
5. **The confirmation modal.** Plain-English summary, a duration estimate, who gets
   emailed, and an acknowledgement checkbox that appears only for the dangerous option.
6. **One page template for create and read.** A completed job is the same page, disabled.
7. **The markets kill-switch in settings.** One checkbox hides an entire feature domain
   from the merchants who do not need it.
8. **Timezone stated in the form**, next to the pickers, with the current time in it.
9. **`Copy to new job`** as a first-class header action.
10. **Errors twice: banner summary + inline field.**

## What they cannot do, structurally

- **No failure states.** `Pending · Queued · In progress · Complete · Reverting ·
  Reverted`. Nothing represents "wrote 4,200 of 5,000 and stopped", which is the state a
  rate-limited bulk price write actually ends in.
- **Revert restores a stored number.** It does not recompute. Two overlapping jobs on the
  same variant, reverted out of order, drift — and a 1★ review on their listing describes
  exactly that.
- **No recurrence.** `Copy to new job` is manual repetition; a weekly sale is a weekly
  chore.
- **No baseline concept.** Relative rules read the live price, so running "-10%" twice
  compounds.
- **No read-back verification.** "Complete" means the mutations were sent.
- **One filter dimension on the job list**, no search across what a job *did*, and no
  store-wide view of "which campaigns touch this variant".
- **Change-count metering** taxes exactly the behaviour a campaign manager encourages.
