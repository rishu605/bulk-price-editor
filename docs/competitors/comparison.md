# Anchor vs the category — what to change, and why

*29 Aug 2026. Written after walking NA Bulk Price Editor, RUBIX Bulk Price Editor and
Sami Bulk Price Editor live on `dartmode-labs`, then walking our own production build on
the same store in the same browser session.*

The headline is not a feature gap. We have more of the things that matter than any of
them — a baseline, a resolver, a ledger, verified-clean runs, drift detection, per-market
rounding. A merchant on a trial cannot see any of it, and the create flow is where they
look.

---

## 0. A correction, recorded rather than deleted

The first version of this document opened with a P0: that the embedded app did not scroll,
and that the campaign editor's Create button was therefore unreachable. **That was wrong.**
Scrolling works correctly in the admin.

What actually happened: the browser automation's synthetic wheel events reached the outer
admin document for the three competitor apps — whose iframes grow to content height, so the
*admin page* is what scrolls — and did not reach our page's own scroll container inside the
frame. The supporting evidence was weak in the same way: "focus left the iframe after three
tab presses" is something App Bridge can cause, and does not mean there were only three
fields.

It is left here rather than deleted because the failure is instructive and will recur. A
tool that drives one app successfully is not thereby validated against another, and
"competitor scrolled, ours did not, same wheel events" is a comparison between two
different scroll architectures, not a controlled test. **When an observation implies
something as severe as "the product cannot be used", reproduce it by hand before writing it
down.**

Filed as #441 and closed as not-a-bug. Nothing in the rest of this document depended on it.

## 1. The three of them, at a glance

| | NA | RUBIX | Sami | **Anchor** |
|---|---|---|---|---|
| Launched | Oct 2020 | Jul 2020 | **Apr 2025** | not launched |
| Rating | 4.9★ / 227 | 4.8★ / 130 | 4.8★ / 164 | — |
| Built for Shopify | ✅ | ✅ | ✅ | targeted |
| Nav items | 2 (Settings, Plans) | 4 (all meta) | **0** | **5** |
| The noun | "price change job" | task / campaign / job / discount task | "bulk edit task" | "campaign" |
| Entry point | "how should prices change" (4 radios) | "which campaign type" (modal) | **"which field" (card gallery)** | "1 · Scope" |
| Live preview | inline, below the rule | **none** | **beside the form** | inline, behind a button |
| Confirmation | **modal + duration + ack** | none | none | ? (below the fold) |
| Failure states | **none** | none | **`Partially complete`** | PARTIAL / HELD |
| Recurrence | none (`Copy to new job`) | Weekly (paid) | **Daily, multi-window** | yes |
| Baseline model | none | none | none | **yes** |
| Revert | restore stored value | restore stored value | restore stored value | **recompute** |
| Metering | changes/month | variants/month | free | variants under management |
| Free tier | 100 changes/mo | 150 variants/mo | **everything** | 500 variants |
| Paid | $9.95–$49.95 | $7.95–$14.95 | — | tbc |
| Languages | 1 | 1 | **18** | 1 |

Two things fall out of that table immediately.

**Sami is the threat, not NA.** It launched sixteen months ago, is free, ships in eighteen
languages, has the best editor in the category, and is the only competitor that admits a
run can be partially complete. NA has the reviews; Sami has the trajectory.

**Nobody has a baseline.** All three revert to "whatever the price was when this run
started". Rubix documents the resulting drift in its own FAQ (§4 below). That is the whole
product thesis, and it is still true.

---

## 2. What they do better than us — in order of how much it costs us

### 2.1 The preview is next to the control, and it is free

Sami's editor is **two panes**: a narrow form on the left, a wide preview table on the
right with `Original price · Update price · Original compare at price · Update compare at
price` over the merchant's real catalogue. Typing `10` turned `$949.95` into `$854.96` on
every row instantly.

NA does it differently and just as well: a **`STOREFRONT EXAMPLE`** card beside the rule
showing one real product before → after *as the storefront would render it*, plus the full
paginated list below.

Ours has `DraftPreview` — which runs the *real planner over real baselines*, so it is
strictly more truthful than either of theirs — and puts it below the fold behind an
`Update match count` button the merchant has to press. **We built the harder half and then
hid it.**

### 2.2 The scope list has pictures and after-prices

Ours renders matches as a bare bullet list: `Alpine Backpack 133 · S · 538.04`. One line,
no thumbnail, current price only, no "after".

NA and Sami both show a thumbnail, the product name, the old price struck through and the
new price. A merchant recognises a product by its picture.

### 2.3 CSV is an option, not a destination

NA's "Use CSV upload" is the **fourth radio** in "how should prices change", and choosing
it makes the product-selection step *disappear*, because the file is the scope.

Ours is `/app/campaigns/import`, reached from a separate "From a spreadsheet" button. We
already learned this lesson once — #416 dissolved the Imports nav item because "a nav item
should be a noun" — and the import is still a different door rather than a different
answer to the same question.

### 2.4 A named "Advanced settings (optional)" bucket

NA's step 5 is four collapsed, off-by-default checkboxes with that exact heading. It is
the pressure valve that keeps steps 1–4 short.

We have "Advanced (optional)" inside section 2 — the idea is there. What we do not have is
the discipline it buys: our section 2 still carries name, rule, amount, compare-at,
rounding, a market checkbox per market, a rounding select per currency, four schedule
fields, priority, tags, auto-enrol and a revert buffer.

### 2.5 A confirmation that is a sentence, not a form

NA's modal, verbatim in shape:

> **Sale** 20% off
> **Scheduling** This job is scheduled to start on 30 August 2026. This job is scheduled to revert on 5 September 2026.
> **Product variants affected** 1
> **Tags to add** price-change-job-active
> **Discount codes** All carts that contain any affected product will have all discount codes blocked
>
> *A price change job like this usually takes a minute or less to complete.*
> An email will be sent to `you@example.com` when the job has completed.
> ☐ I understand that this price change job will block discount codes …

Three things in there we do not do: **a plain-English restatement** of what is about to
happen, **a duration estimate sized to the job**, and **an acknowledgement checkbox that
appears only for the dangerous option**. Rubix and Sami have no confirmation at all — Sami
will change every price in the catalogue on one click of Save.

### 2.6 The commonest job is one field on the landing page

Sami's dashboard has **Quick Discount Campaign Setup**: one number, one unit select, one
checkbox, `Quick Create`. "20% off everything" never opens the editor.

Our Home offers `Start a practice campaign` and `Create a guided campaign` — both of which
open the full editor.

### 2.7 A sandbox to learn in

Sami: **"Try a demo run first — We'll create a demo products so you can review the results
before updating real products"**, one button. Nobody else has this. Our practice mode is
philosophically better (it prices the merchant's *real* catalogue and refuses to write)
but it is a mode you must know to ask for, presented as a checklist item on Home.

### 2.8 The list says what each run *did*

Sami's columns: `ID · Name · Recurring · Status · Progress · Applies to · Editing rules ·
Created at`, where `Editing rules` renders **"Price decrease by 10%"** and `Applies to`
renders **"All products"**. The index answers "what is this" without opening anything.
NA does the same in prose: *"20% off sale on 1 product variant"*.

Our campaigns index has status tabs, search and paging — and does not render the rule.

### 2.9 One page template for create and read

NA's `/jobs/:id` is `/jobs/new` with every control disabled, a status banner prepended and
two labels changed (`Price change preview` → `Price change recap`, `→` → `↺`). One page
shape to learn.

Ours are two different pages: a two-section editor and a five-tab detail view.

### 2.10 Small things that are cheap and land

- **Timezone stated next to the schedule pickers**, with the current time in it (NA), and
  **settable** with a plain-English echo — *"The task will run from 06:00 to 18:00 on 29
  Aug"* (Sami).
- **A character counter** on the name field (Sami, `8/100`).
- **A prefilled name** so it is never a blocker (NA, Sami).
- **`Copy to new job` / `Duplicate`** as a first-class action (all three).
- **`Note` on a run** and **`Archive` instead of delete** (Sami).
- **A usage meter with a progress bar on the landing page** (Rubix).
- **`Exclude products`** beside "apply to products" (Sami).
- **Rounding helper text that shows the arithmetic on an example number** (Sami).
- **A `Task ID` field in the support form** (Rubix).
- **Live chat** (Sami), **per-field video tutorials** (Sami), **18 languages** (Sami).

---

## 3. What we do better — and how much of it is visible

| We have | They have | Is it visible in our UI? |
|---|---|---|
| Baseline: relative rules read a captured baseline, never the live price | nothing | Yes — Home, `/app/prices/baselines` |
| Revert = `resolve(without C)` — recompute, not restore | restore a stored number | **Only in help prose** |
| Overlapping campaigns resolve by priority | Rubix tells you not to; NA and Sami are silent | **Only in help prose** |
| Write-ahead ledger, verified-clean runs, PARTIAL/HELD | NA: nothing. Sami: `Partially complete` | Partly — "Needs a decision" tab |
| Drift detection (storefront changed under us) | nothing | Yes — `/app/prices/drift` |
| Guardrails: never price at or below cost, min margin, min price | nothing | Yes — Settings |
| Per-market rounding and per-currency precision (JPY) | NA has global rounding; Rubix has one dropdown | Yes |
| Market pricing from *each market's own baseline*, not converted | NA converts from base; Rubix sets fixed prices | Yes, but buried |
| Recurrence | Sami: daily. Rubix: weekly (paid). NA: none | Yes |
| Segments (saved scopes) | nothing | Settings tab |
| Practice mode over the real catalogue | Sami's demo product | Home checklist |
| CSV round-trip with Matrixify-compatible headers | NA: upload only | Separate page |
| Activity log with actor attribution | nothing | Home aside + `/app/activity` |

**The pattern: our differentiators are real and mostly invisible.** The two that matter
most — the baseline and recompute-revert — appear in the product as help prose. A merchant
comparing four apps in a trial week will not read prose.

Rubix's own FAQ is the argument, pre-written by a competitor:

> *when you revert task 2, it will not revert to the original one ($1000), instead it will
> revert to the initial price of task 2.*
> **So, please revert the first task BEFORE create the second task if you want to modify
> the same products**

We should be able to put a merchant in front of that exact scenario and show it not
happening. Today the editor has no way to say it.

---

## 4. Where each of them will lose a merchant

Useful for the beta script in `docs/beta-programme.md` — these are the sentences to open
with.

**NA** — no failure state exists. `Pending · Queued · In progress · Complete · Reverting ·
Reverted`. A rate-limited run over 100,000 variants either completes or does not appear.
Revert restores a stored number, so overlapping jobs drift. No recurrence: a weekly sale
is `Copy to new job`, by hand, every week.

**RUBIX** — the compounding bug is documented in the FAQ and warned about in the editor
aside. There is no price preview at all; the Quick Start Guide tells the merchant to check
the storefront afterwards. There is no confirmation and no submit button in the form.
Four names for one object.

**Sami** — no baseline, and no warning either, so it compounds silently. Save with
`Start time: Now` changes every price in the catalogue with no summary and no
acknowledgement. Markets are two flat fields with no catalogue model behind them.

---

## 5. What to build, in order

Every item below became a GitHub issue under **Epic 15**.

### P1 — the create flow, which is where a trial is won or lost
1. **Two-pane editor**: form left, live preview right, always visible, no button to press.
2. **Preview rows get thumbnails and an after-price**, not a bullet list of text.
3. **One `STOREFRONT EXAMPLE`** — one product, before → after, storefront rendering,
   beside the rule.
4. **CSV becomes a rule option**, not a separate door; the scope step disappears when it
   is chosen.
5. **A confirmation step**: plain-English summary, variant count, duration estimate, who
   gets emailed, and an acknowledgement only where the choice is dangerous.
6. **Name and rule come first**, scope second — the form should open with the decision, not
   the filter.

### P2 — make the differentiators visible
7. **Show the baseline in the editor**: every preview row reads baseline → new, and says
   which campaigns are already in play on those variants.
8. **An overlap panel**: "3 of these variants are already priced by *Autumn Sale*. This
   campaign has priority 2, so it wins." Nobody else can render that sentence.
9. **Revert explained where it is used**, not in help: "Reverting recomputes without this
    campaign — it does not restore a saved number."

### P3 — the landing page and the list
10. **Quick create on Home**: one percentage, one button.
11. **A metric strip on Home** — active · scheduled · needs a decision · reverted — in
    place of the `Mirror audited` activity feed, which is system jargon.
12. **The campaigns index renders the rule and the scope** as sentences.
13. **`Duplicate` on a campaign**, and `Note`, and archive-not-delete.

### P4 — craft, cheap and visible
14. Timezone beside the schedule, settable, with a plain-English echo.
15. Prefilled campaign name with a character counter.
16. Rounding helper text that shows the arithmetic on an example number.
17. `Exclude products` beside the scope filter.
18. A usage/plan meter on Home.
19. Per-page help videos or a "what this does" example on the rule select.

### P5 — reach
20. Localisation. Sami ships eighteen languages and is free; that is a distribution
    argument, not a feature.
21. In-app support: a contact form that captures the run id, at minimum.

---

## 6. What must not be flattened while doing any of this

From `CLAUDE.md`, restated because a UX pass is exactly when these get traded away:

- Campaign math reads the **baseline**, never the live price.
- **Preview and execution share one code path.** A two-pane preview must still be
  `resolve()`, not a cheaper estimate written for the sidebar.
- A run is clean only when every row is **read-back verified**. PARTIAL and HELD belong in
  the campaign header, not inside a tab.
- **Revert means recompute.** Do not add a "restore original prices" button because three
  competitors have one.
- Money is integer minor units. A live-updating preview that formats on every keystroke is
  the obvious place for a float to appear.
