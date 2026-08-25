# Importing your own prices

If you keep an MSRP, list price or RRP somewhere other than Shopify, import it. Every
campaign will then compute from that number rather than from whatever your storefront
happened to show the day you installed.

## The file

One row per variant. A SKU, barcode or variant ID, then the price.

```
Variant SKU,Variant Price
CH-1,129.00
CH-2,149.00
```

A file exported from **Matrixify** works as it is — its column names are recognised.

Prices must be plain numbers: `1299.00`, not `$1,299.00`. Add a currency column if some
rows are in a different currency from your store's.

## Check before you commit

**Check without importing** runs the whole thing and writes nothing. It reports how many
rows matched, how many did not, and exactly which rows have problems — with line numbers.

Fix those rows and re-upload. One bad row never rejects the file.

## What "ambiguous" means

A SKU that names two variants is a question, not a match. The app will not guess which one
you meant, because guessing wrong sets a permanent wrong reference price on a product.

Either make the SKU unique, or use variant IDs.

## Costs

Same shape, with a cost column instead — see **Import costs**. Worth doing if you use the
"never price below cost" guardrail: without costs, that setting silently protects nothing.
