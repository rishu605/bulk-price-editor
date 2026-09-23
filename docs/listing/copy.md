# App Store listing: the actual field values

Paste-ready. One section per field in the Partner Dashboard listing form, with the
character limit and the count next to it. `npm run check:listing` recounts them.

Strategy and the reasoning behind these choices live in
[`docs/app-store-listing.md`](../app-store-listing.md). This file is what goes in the boxes.

House rule for this copy: no em dashes, plain sentences, no claim that is not backed by
something in the repo. Anything a reviewer could check, we can show them.

---

## App name

Limit 30.

```
Anchor: Bulk Price Editor
```

Two names, and they are not the same field.

- **App name**, set in the app's settings and written in `shopify.app.toml`: `Anchor`.
  This is what sits in the admin sidebar every day, so it is one word and nothing else.
- **Listing name**, the field above, capped at 30 characters: `Anchor: Bulk Price Editor`.
  The App Store is a search box, so the listing name carries the term merchants type.

The name does the work the app does. Every campaign computes from a fixed reference price
instead of from whatever the storefront happens to show, and that reference is the thing
the whole product is built on. Calling it Anchor means the one idea a merchant has to hold
on to is already in the name.

Search terms below carry the rest of the keywords, because Shopify now marks a
keyword-stuffed name down rather than up.

## App card subtitle

Limit 62. This is the line under the name on search and category cards.

```
Schedule sales across markets and revert them exactly
```

## App introduction

Limit 100. First line on the listing page itself.

```
Run scheduled price campaigns across every market, and always know which price is live and why.
```

## App details

Limit 500.

```
Anchor treats a price change as a campaign. It has a start, an end, a scope, and a preview, and every price in it is computed from a baseline you set rather than from whatever the storefront happens to show today.

That one decision is what makes the rest work. Running a campaign twice changes nothing the second time. Ending a sale restores the right price even when another campaign is still running on the same product. Overlapping campaigns resolve to one winner instead of stacking.
```

## Feature list

Up to 5 bullets, limit 80 each.

```
Every price computes from a baseline, so campaigns never stack or compound
Reverting recomputes the correct price instead of restoring an old one
Per-market prices and compare-at in each market's own currency and rounding
One page shows every live price, its baseline, and the campaign that set it
Preview, full history and one-click rollback on every plan, including free
```

## Search terms

Up to 5, limit 20 each.

```
bulk price editor
bulk price change
price scheduler
markets pricing
sale scheduler
```

## Categories

Primary and secondary are picked from a fixed dropdown, so these are the intent rather
than the exact strings. Confirm against the live list when filling the form.

- **Primary:** Store management, under product or bulk editing.
- **Secondary:** Marketing and conversion, under discounts or promotions.

Competitors in this category sit under store management almost without exception, and the
secondary is what picks up merchants shopping for a sale tool rather than an editor.

## Integrations

Up to 6. Only three are real, so only three are listed. A padded integration list is the
sort of thing a reviewer checks.

- Shopify Markets
- Shopify B2B
- Shopify Flow

## Languages

English.

Localisation is an open product question, not a shipped feature, so the listing says one
language rather than implying more.

## Pricing

Matches `app/lib/billing/plans.ts` exactly. A listing that disagrees with what the merchant
is actually charged is the one review nobody recovers from.

| Plan | Price | Variants | Markets | B2B |
|---|---|---|---|---|
| Free | Free | 500 | No | No |
| Growth | $14.90 / month | 10,000 | No | No |
| Markets | $34.90 / month | 100,000 | Yes | No |
| Wholesale | $69.90 / month | Unlimited | Yes | Yes |

14 day free trial on all paid plans. Development stores are free.

Worth saying in the pricing blurb, because it is unusual in this category:

```
Preview, guardrails, full history and rollback are included on every plan, including Free. Anchor meters the catalogue you manage, never the number of price changes you make.
```

## Screenshot captions

Up to 5, limit 100 each. In order, matching the files in
[`images/`](images/). The first two are designed panels that carry their own
wording, so their captions repeat the claim rather than describing a screen; the
rest are real screens of the app against `boltify-apps`.

```
Every campaign is computed from a baseline, so prices never compound and reverts are exact.
Campaign pricing, not bulk editing: preview, guardrails, history and rollback on every plan.
Every live price on every surface, next to its baseline and the campaign that set it.
The exact rows a campaign will write, recomputed as you build the rule, before anything runs.
Two campaigns on one calendar, how many products they share, and which one wins.
```

### The files

Shopify wants 1600x900 for every screenshot, mobile ones included, so the phone captures go
on the same landscape canvas as the desktop ones rather than a portrait one. The 900x1600
`mobile-*.png` files are kept because the same panels are useful at that ratio elsewhere,
but they are not what the listing carries.

Every capture is cropped to the app's own screen. The admin's left nav and top bar are not
the app and reviewers see them on every listing, so they are gone; the app's title bar, which
is the one piece of chrome the app controls, stays. The phone captures are taken at 400px
wide against the live app, not scaled down from a desktop shot.

| Slot | File | Alt text |
|---|---|---|
| Feature media | `desktop-01-hero.png` | Anchor computes every price from a baseline you control |
| Desktop 1 | `desktop-02-capabilities.png` | Six ways Anchor differs from a bulk price editor |
| Desktop 2 | `desktop-03-whats-live.png` | Live price, baseline and the campaign that set it |
| Desktop 3 | `desktop-04-preview.png` | Campaign preview showing each baseline and the price it becomes |
| Desktop 4 | `desktop-05-calendar.png` | Campaign calendar showing two overlapping sales |
| Desktop 5 | `desktop-06-ledger.png` | Run ledger with before, intended and verified per variant |
| Mobile 1 | `mobileview-01-home.png` | Campaigns running, scheduled and needing attention |
| Mobile 2 | `mobileview-02-campaigns.png` | Campaign list showing each rule, scope, priority and last run |
| Mobile 3 | `mobileview-03-whats-live.png` | Every written price checked back against Shopify |

Alt text is capped at 64 characters, which is shorter than the caption limit and short enough
that a sentence has to become a label. Say what the image shows, not what device it is on:
the same screenshot is a phone screenshot and a narrow-window screenshot, and the reader with
a screen reader does not care which.

Images 1 and 2 are designed panels built by the compose script kept in the scratch work; the
rest are unretouched captures placed on the same canvas.

### Not yet capturable

The per-market matrix, one column per market priced in its own currency, is the strongest
screenshot this app can take and it is not in the set. Both development stores answer every
market in USD because no payment provider is active, which is
[`environments.md`](../environments.md) behaviour rather than an app fault. Taking it needs
a store where markets really answer in their own currency.

## Resources

- **Support email:** shared inbox, not a personal address. A personal address on a listing
  outlives the person's involvement with the app.
- **Privacy policy URL:** must state that the app stores prices and product metadata and no
  customer data, that access tokens are encrypted at rest, and that telemetry carries no
  price values. All three are true and all three are worth saying out loud.
- **FAQ URL:** `docs/help` is already written and ships in the app at `/help`.

---

## Still blocked

- Name availability check in the Partner Dashboard. Blocks decision D6.
- The per-market screenshot, which needs a store whose markets answer in their own
  currency. See above.
- The screencast: install, campaign, preview, apply, revert. Ninety seconds.
- Privacy policy published at a stable URL.
- Support inbox created.
