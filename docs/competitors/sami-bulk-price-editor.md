# Sami Bulk Price Editor — teardown

*Captured 29 Aug 2026 by walking the live app on `dartmode-labs.myshopify.com`. One task
was created (`#75577`, Manual start, never run) to observe the commit flow, then archived;
no prices were changed.*

| | |
|---|---|
| Vendor | SamiSales by Samita (Hanoi, VN) |
| App handle | `bulk-price-editor-sami` |
| Tagline | "Bulk product editor & auto-revert prices for sales campaigns" |
| Rating | 4.8★ / 164 reviews (91% five-star, 3% one-star) |
| Built for Shopify | Yes |
| Launched | **17 Apr 2025** — by far the newest of the three |
| Categories | Bulk editor (Store Management) |
| Languages | **18** — English, French, Italian, Chinese (Trad & Simp), Japanese, German, Spanish, Turkish, Swedish, Polish, Norwegian, Korean, Finnish, Dutch, Danish, Czech, Portuguese (BR) |
| Pricing | **Free.** No paid tier on the listing, no pricing page in the app |
| Scopes granted | Products (view+edit), "Other data" — **no Discounts scope** |

Sami is the newest, the most polished, and the only one that is free. It is also the only
one of the three whose *information architecture* is genuinely different: it is a **bulk
product editor** that happens to be excellent at prices, entered by picking a field rather
than by picking a price rule.

## The shape of the whole app

**No nav sub-items at all.** The Shopify sidebar shows only "Bulk Price Editor Sami". The
whole app is: Dashboard → Bulk Edit Tasks → Create task. Settings and plans do not exist as
pages (there is nothing to configure and nothing to buy).

A **live-chat bubble** floats bottom-right on every page. A **language selector** sits in
the dashboard header.

## Page 1 — Dashboard

- `Hello ,` (the name interpolation is empty — a small bug) and `🌍 English ▾`
- `👋 Welcome to: Bulk Price Editor - Sami by Samita`
- **A four-metric strip**: `Total tasks` · `Tasks completed` · `Tasks reverted` ·
  `Tasks scheduled`. *Tasks reverted* being a headline metric is a statement of what the
  product thinks it is for.
- **Bulk edit products with Sami** — "Quickly update multiple products at once in just a
  few clicks with an efficient bulk editing workflow" + `New bulk edit` · `View task history`
- **Quick Discount Campaign Setup** — *"Quickly create a discount campaign task—just enter
  your target price and click **Quick Create**"*
  - `Discount` [ number ] [ Percentage ▾ ]
  - ☐ **Update compare-at price only** — *"Keep the current price unchanged and set a
    higher compare-at price to display a discount"*
  - `Quick Create` · `Learn more`
- **Need any help?** — three tiles: `Get email support` / `Start live chat` / `Help docs`

**The Quick Create pattern is worth stealing outright.** The single most common job — "run
a X% sale on everything" — is one number and one button on the landing page. Everything
else is behind "New bulk edit".

## Page 2 — "Choose a Field to Edit"

`New bulk edit` does not open a form. It opens a **gallery of field cards**, filtered by
`All fields | Product fields | Variant fields`.

Each card shows a **worked before → after example rendered with a real product image**
(e.g. *Long Sleeve Tee · ~~$250.00~~ → $300.00*), the field name, a `Most popular` badge
where applicable, whether it is a Product or Variant field, `+ Select`, and — notably —
**`▷ Video tutorial`** per field.

The eleven fields:

| Field | Scope | Badge |
|---|---|---|
| Price | Variant | Most popular |
| Compare at price | Variant | Most popular |
| Price by market | Variant | |
| Compare at price by market | Variant | |
| Cost price | Variant | |
| SKU | Variant | |
| Barcode | Variant | |
| Title | Product | |
| Status | Product | |
| Description | Product | |
| Tags | Product | |

Footer: *"Learn more about Bulk Edit Tasks"*.

**This is the cleanest answer to "how do I start?" of the three apps.** NA asks "how should
prices change"; Rubix asks "what campaign type"; Sami asks "what do you want to edit",
shows you a picture of the answer, and offers a video.

## Page 3 — Create task (the editor)

**A two-pane layout: a narrow form column on the left, a wide live preview on the right.**
This is the single biggest structural difference from NA (preview inline, below the
control) and Rubix (no preview at all).

### Left column — stacked cards

**Task name** — prefilled `New task`, with a `8/100` character counter.

**Field to edit**
- `Field` [ Price ▾ ]
- `Edit method` [ Decrease by percentage ▾ ] — ten options for the price field:
  1. Increase by percentage
  2. Increase by amount
  3. Increase by percentage of cost price
  4. Decrease by percentage *(default)*
  5. Decrease by amount
  6. Decrease by percentage of cost price
  7. Set as percentage of price
  8. Set as percentage of compare at price
  9. Set the price to the current compare-at price
  10. Set the price to the current cost price
- `Value` [ __ % ]
- `Rounding` [ Round to nearest .01 ▾ ] with helper text that *shows the arithmetic*:
  *"Round to two decimal places. For example, a price of 10.458 would be rounded to 10.46"*

**Compare at price** — `Don't change compare-at price` *(default)* / `Set the compare-at
price`. A second field edited from within the first field's task.

**Apply to products** — `All products` / `Collections` / `Specific products` /
`Match conditions`. Match conditions opens `Products must match: ( ) all conditions
(•) any condition` then `[ Title ▾ ] [ contains ▾ ] [ value ]` + `Add another condition`.

**Exclude products** — ☐ `Specific products`. *An explicit exclusion list, which neither
other app has.*

**Apply to variants** — `All variants` / `Match conditions`. Product-level and
variant-level scoping are separate controls.

**Start time** — four radios:
- `Now`
- **`Manual`** — the task exists but only runs when you press "Apply change now"
- `Schedule the edit`
- **`Recurring`**

**Revert time** — ☐ `Schedule the revert`

### Recurring, in detail

`Recurring` reveals `[ Daily ▾ ]` plus a repeatable window block:

> `Start date [29/08/2026]` `End date [29/08/2026]`
> `Start time (hh:mm) [06] [00]` `End time (hh:mm) [18] [00]`
> *The task will run from 06:00 to 18:00 on 29 Aug*
> `⊕ Add another condition`
>
> Timezone: **(GMT-05:00) Eastern Time (US & Canada)**. *Change timezone*

Three things there that the other two apps do not have: a **plain-English echo of the
schedule**, **multiple windows per task**, and a **timezone the merchant can change**
rather than one inferred from the browser.

### Right column — the live preview

- A dismissible banner: **"Try a demo run first — We'll create a demo products so you can
  review the results before updating real products"** + `Create product`.
  **A one-click sandbox.** No competitor and no version of our app has this.
- **Preview** — a real table over the merchant's own catalogue:
  `Product | Original price | Update price | Original compare at price | Update compare at price`,
  with thumbnails, variant sub-rows indented under the product, horizontal scroll, and
  pagination. It recomputes as you type: entering `10` turned `$949.95` into `$854.96`
  across every row instantly.
- Empty state when a filter matches nothing: a magnifier illustration, **"No products
  found"**, *"Try changing the filters or search term"*.

### Commit

There is **no confirmation step**. App Bridge `Save` writes the task and navigates to
`/admin/tasks/:id`. With `Start time: Now` that is a live price change on the merchant's
whole catalogue, one click, no summary, no "this affects N variants", no acknowledgement.

The saved task page is the same editable form, with a `Duplicate` action in the header.

## Page 4 — Bulk Edit Tasks (the list)

**The best list view of the three.** Nine status tabs:

`All | Pending | Running | Completed | Scheduled | Partially complete | Revert completed |
Pause | Archived`

> **"Partially complete" is a first-class, filterable status.** NA has no failure state at
> all. This is the only competitor that admits a run can stop halfway.

Columns: `ID (#75577) | Name | Recurring | Status | Progress | Applies to | Editing rules |
Created at | ⋮`

- **`Editing rules`** renders the rule as a sentence — *"Price decrease by 10%"* — so the
  list answers "what does this task do" without opening it.
- **`Applies to`** renders the scope — *"All products"*.
- **`Recurring`** renders *"One-time"* or the recurrence.
- **`Progress`** is a dedicated column for in-flight runs.
- Status renders as a badge — *`Manual start`*.

Row menu (⋮): **`Apply change now`** · `Duplicate` · `Archive` · **`Note`**.

Archiving shows a toast: *"Task archived ×"*. There is no destructive delete.

`Note` — attaching free text to a run — is a small idea with a large payoff: it is where
"why did we do this" lives.

Empty state: a custom illustration plus *"Get started with Bulk Editing — Quickly edit
product fields at scale with live previews, scheduled changes, and rollbacks — all in one
place."* with `Learn More` and `New Bulk Edit Task`.

## What they do that we should copy

1. **Quick Create on the dashboard** — the commonest job as one field and one button,
   with the full editor a separate door.
2. **"Choose a field to edit" as the entry point**, with a *pictured* before → after per
   field and a per-field video.
3. **The two-pane editor: form left, live preview right.** The preview is never below the
   fold and never a separate step.
4. **A preview table with `Original` and `Update` columns for both price and compare-at**,
   recomputing on every keystroke over the merchant's real catalogue.
5. **"Try a demo run first" — a generated sandbox product.** The safest possible way to
   learn what a rule does.
6. **`Partially complete` as a filterable status**, plus `Progress` as a list column.
7. **`Manual` as a start mode** — build the task now, press the button later. Neither a
   draft nor a schedule.
8. **A timezone the merchant sets**, with a plain-English echo of the schedule.
9. **`Exclude products`** as a control beside `Apply to products`.
10. **`Note` on a run** and **`Archive` instead of delete**.
11. **Rounding helper text that shows the arithmetic** on an example number.
12. **Rules rendered as sentences in the list** (`Price decrease by 10%`), so the index is
    readable without opening rows.
13. **Eighteen languages.** Ours is English-only.

## What is weak

- **No confirmation before a live write.** Save with `Start time: Now` changes every price
  in the catalogue with no summary and no acknowledgement. The safest editor in the
  category has the least safe commit.
- **No baseline.** "Original price" in the preview means the current live price, so a
  second task compounds exactly as Rubix's does — Sami simply does not warn about it.
- **No markets depth**: `Price by market` and `Compare at price by market` are single
  fields, with no catalogue/B2B/POS model behind them.
- **No cost-margin guardrail** — `Decrease by percentage of cost price` exists as a rule,
  but nothing stops a rule pricing below cost.
- **`Hello ,`** — an empty interpolation on the first line of the first page.
- **No usage, plan or settings surface**, which is fine today and a cliff the day they
  introduce billing.
