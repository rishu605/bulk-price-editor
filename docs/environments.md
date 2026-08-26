# Stores, app record and what each is for

## The app

| | |
|---|---|
| Handle | `bulk-price-editor-98` |
| Name | `bulk-price-editor` |
| Client id | `5401aeddaf37aac5c9e1650bf6abb462` |
| Partner organisation | `193923261` |

The client id lives in `shopify.app.toml`, written by `npm run config:link`. It is not a
secret — the secret is `SHOPIFY_API_SECRET`, which lives only in `.env` and in the hosting
platform's variables, never here.

## Two stores, because they test different things

### `boltify-apps.myshopify.com` — "DartMode Labs"

The small one, for day-to-day feature work. Around 3,700 variants, EUR and JPY markets,
and the store every screenshot and manual check has been taken against.

Its display name and its domain disagree, which has confused people before: **DartMode
Labs *is* `boltify-apps.myshopify.com`**. One store, renamed, not two.

### `anchor-perf.myshopify.com` — "Anchor Perf"

The scale one. 2,001 products, **102,132 variants**, including the 2,048-variant product
edge case E12 is about. On Plus, so B2B company catalogues are real there rather than
theoretical.

Markets: United States (USD), Europe (EUR, Germany, −10%), Japan (JPY, −20%). JPY is
deliberate — it is zero-decimal and breaks naive rounding (E9).

Seed or re-seed it with:

```shell
npx tsx scripts/seed-store.ts 2000 --variants 50 --shop anchor-perf
npx tsx scripts/seed-store.ts --max-variant-product --shop anchor-perf
```

`--shop` is not optional when more than one store is installed, and that is deliberate:
the seeder writes a hundred thousand products, and picking the first row it finds is a
coin toss whose losing side cannot be undone quickly.

## Multi-currency on a development store

The Markets UI offers only "Complete account setup" for currency until a payment provider
is active, which reads like it needs Shopify Payments and real business details. It does
not: **Settings → Payments → test payment gateway → Activate** unlocks per-market
currencies with no financial information involved.

Worth knowing, because without it a dev store is stuck on Dynamic FX and the app has no
price lists to read.

## Why the perf store earns its keep

It found a bug the small store could not. `variants(first: 100)` in the catalogue sync
silently dropped 1,948 of the 2,048-variant product's variants; a campaign covering that
product would have priced 100 of them and reported the run clean. The small store's largest
product is 65 variants, so every test and every manual check passed through the one branch
where the bug is invisible. Fixed in #291.

Numbers from it are in [`perf/README.md`](perf/README.md).
