# Extensions

Six, all Flow. See `docs/help/how-to/shopify-flow.md` for what each does.

## They are generated, not hand-written

```shell
npx shopify app generate extension --template flow_trigger --name anchor-campaign-started
npx shopify app generate extension --template flow_action  --name anchor-start-campaign
```

Then the generated manifest is filled in. That matters: an earlier attempt hand-wrote them
and the CLI rejected every shape with `is invalid` and no field named — because the current
format wraps everything in an `[[extensions]]` array-of-tables and carries a generated
`uid`, neither of which is obvious from the error or the docs.

**A manifest the CLI rejects stops `npm run dev` starting at all**, and CI never runs the
CLI, so a bad one passes every check in the repo and breaks every developer. Generating the
scaffold is what stops that happening again.

## Field keys differ between triggers and actions

| | Keys look like | Example |
|---|---|---|
| Trigger | alphabetic characters and spaces | `"campaign id"` |
| Action | an identifier | `"campaign-id"` |

The CLI's own scaffolds show both, which is how the difference was settled. Trigger keys
must match `TriggerPayload` in `app/services/flow.server.ts` **exactly**, or the trigger
arrives with every field empty and nothing complains.

## What is still missing

A release. `shopify app deploy` publishes extensions, and it also publishes whatever
`application_url` is in `shopify.app.toml` — which is currently a dead development tunnel.
Deploying before that points at the real hosted URL would take the app down for anything
that is not a `shopify app dev` session.

So: set `application_url` to the Railway domain, then deploy, then remove the "not
available yet" notice from the help page.

## No theme app extension, ever

Not a gap. The app's entire storefront contract is a campaign-scoped product tag, which is
what lets it claim no storefront performance impact — and a pricing app has no business in
a merchant's theme. `app/lib/compliance/built-for-shopify.test.ts` fails if one appears.
