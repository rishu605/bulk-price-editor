# App Store listing — draft copy

Everything here is written and ready. What is missing needs a Partner account or a
deployed app: the name availability check, the screenshots, the screencast, and the
published privacy policy. Those are marked.

---

## Name

**App name:** Anchor
**Listing name:** Anchor: Bulk Price Editor & Market Pricing

The category uses keyword-bearing listing names and search rank depends on them, so the
listing name carries the terms merchants actually type — "bulk price editor", "market
pricing" — while the app name stays short, because that is what appears in the admin
sidebar every day.

"Anchor" is the baseline concept made into a word: every campaign computes from a fixed
reference price rather than from whatever the storefront happens to show. It is also the
one thing this app does that the category does not.

**Still needed:** availability check in the Partner dashboard. **D6 cannot be closed until
that comes back**, because a name that is taken makes every other decision here moot.

---

## Tagline (100 characters)

> Schedule price campaigns across every market — and always know exactly what is live.

Not "change prices fast". Speed is what the whole category claims and it is not what goes
wrong; a merchant does not lie awake worrying that a sale took four minutes instead of two.

---

## Short description

Run price campaigns the way you run promotions: scheduled, scoped, and reversible.

Every price is computed from a baseline you control, so applying a campaign twice does
nothing the second time and reverting is exact. Every change is recorded before it is
written and read back afterwards — which means "what is live and why" is a page you can
open, not a question support has to guess at.

Price into your markets in their own currencies with their own strike-through prices,
rounded the way each currency should be. Yen has no cents; your prices will not pretend it
does.

---

## Long description

### Prices you can undo

Every campaign computes from a **baseline** — the price a product would be if nothing were
running. Not from the current price. That single decision is why:

- Running a campaign twice does nothing the second time, instead of discounting your discount.
- Ending a sale restores the right price, even if another campaign is still running on the same product.
- Overlapping campaigns never stack. One wins per product, and the preview shows you which.

### You always know what is live

Open one page and see every price on every surface, next to the baseline it came from and
the campaign that put it there. If someone edited a price outside the app, it is flagged as
drifted with both numbers — and you decide whether to keep their change or put it back. The
app never silently overwrites a price a person set.

Spot-check any time: it reads prices straight from Shopify and compares them with what the
app believes.

### Every market, priced properly

A campaign can price into your markets alongside your base price, with a real
strike-through in each market's own currency.

Each market is priced from **its own** normal price, not converted from your base sale
price. If your European prices sit 10% below your base, a 20% sale there means 20% off the
European price — which is what you meant, and not what a converted number gives you.

Rounding is per currency. `.99` where that reads as considered, whole amounts where a
currency has no cents.

### Built for catalogues that are actually large

500,000 variants. Bulk operations, resumable runs, and a rate-limit budget read from
Shopify's own responses rather than assumed. A run that is interrupted picks up exactly
where it stopped, because every row was recorded before it was written.

### Safety is never a paid feature

Preview, guardrails, unlimited history and one-click rollback are on every plan, including
free. Charging for the ability to undo a mistake the app helped you make would be
indefensible.

---

## Screenshots, in order

The first two are the ones nobody else in the category can take. Everything else screenshots
the same filter-and-apply form.

1. **"What is live, and why"** — the reconciliation view, showing live price, baseline, controlling campaign and drift state per variant × surface. This is the trust argument in one image.
2. **The preview matrix with per-market compare-at** — one column per market, each showing that market's own price and strike-through in its own currency. The thing the ecosystem believes Shopify cannot do.
3. **The campaign calendar** — overlapping campaigns, with how many products they share.
4. **The preview before applying** — counts, margin impact, and the products a guardrail would clamp.
5. **The ledger after a run** — every row, what it was, what we wrote, and any that failed with the reason.

**Still needed:** the images. They need the deployed app and a demo store with realistic
data — `npm run seed:store` produces the catalogue.

---

## Screencast

Install → create a campaign → preview → apply → revert. Ninety seconds.

The revert is the part to linger on. Every competitor's demo ends at "prices changed";
ending at "and here they are back exactly as they were, including the one somebody edited
by hand" is the whole differentiator in ten seconds.

**Still needed:** recording, which needs the deployed app.

---

## Pricing section

Matches the configured tiers exactly — a listing that disagrees with what the merchant is
charged is a review nobody recovers from.

| Plan | Price | Variants | Markets | Wholesale |
|---|---|---|---|---|
| Free | Free | 500 | — | — |
| Growth | $14.90/month | 10,000 | — | — |
| Markets | $34.90/month | 100,000 | Yes | — |
| Wholesale | $69.90/month | Unlimited | Yes | Yes |

14-day free trial on paid plans. Development stores free.

**Say on the listing:** preview, guardrails, full history and rollback are on every plan
including free. It is unusual in the category and it is the reason to trust the rest.

---

## Support and privacy

**Support:** a real address, monitored. **Still needed** — it should be a shared inbox
rather than a person, because a personal address on an App Store listing outlives the
person's involvement.

**Privacy policy:** must state what the app stores (prices, product metadata, no customer
data), that access tokens are encrypted at rest, and that telemetry carries no price
values. All three are true and all three are unusual enough to be worth saying.

**Still needed:** publishing it at a stable URL.

---

## What not to say

- **"Fastest bulk price editor."** Everyone says it, nobody can verify it, and it invites comparison on the one axis where being wrong is invisible until a merchant's prices are wrong.
- **"AI-powered."** Nothing here is, and the category is full of listings where it means a percentage field.
- **Anything about the number of price changes.** Pricing does not meter them, deliberately, and mentioning counts invites the comparison anyway.
