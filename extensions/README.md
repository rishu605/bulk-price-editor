# Extensions

Empty, deliberately.

## Flow (#177)

The server side of the Flow integration is built and tested — trigger emission with the
no-prices guarantee in `app/services/flow.server.ts`, and three action endpoints under
`app/routes/flow.actions.*`. What is missing is the extension manifests that declare the
triggers and actions to Shopify.

They were written and then removed, because they could not be validated here. The Shopify
CLI rejected them with `is invalid` and no indication of which field, across several
shapes: `number_integer` is explicitly unsupported on triggers, `number_decimal` and
`single_line_text_field` both failed too, and splitting one extension per directory did not
help either.

**A manifest that fails validation stops `npm run dev` from starting at all**, which blocks
every other piece of work in the repo. That is a much worse outcome than the manifests
being absent, so they are absent until somebody can author them against a Partner app with
Flow enabled and get the CLI to say what it actually wants.

The field keys the server side sends are spaced words — `"campaign id"`, not
`campaign_id` — because Flow validates keys as alphabetic characters and spaces only.
Whatever the manifests end up looking like, their field keys have to match those exactly
or the trigger arrives with empty fields.

## No theme app extension, ever

Not a gap. The app's entire storefront contract is a campaign-scoped product tag, which is
what lets it claim no storefront performance impact — and a pricing app has no business in
a merchant's theme. `app/lib/compliance/built-for-shopify.test.ts` fails if one appears.
