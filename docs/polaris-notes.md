# Polaris web components: what actually works

Notes from getting the app's forms to behave. Written down because each of these cost an
afternoon and none of them fails loudly — the component renders, it just quietly does
nothing.

## `defaultValue` does not work. Use `value`.

`s-text-field`, `s-number-field`, `s-date-field` and the rest all accept `defaultValue` in
their TypeScript types, and it is inherited from a real base class, so it compiles and
looks correct. It renders an empty field.

Verified by putting three fields side by side on one page:

| What was passed | What rendered |
|---|---|
| `defaultValue="camelCase"` | empty |
| `defaultvalue="lowercase"` (forced attribute) | empty |
| `value="valueProp"` | **the value** |

Almost certainly React's special handling of `defaultValue` on form elements: it is
intercepted rather than forwarded to the custom element, so the element never sees it.

Because these forms are uncontrolled — no `onChange`, no state — setting `value` does not
make the field read-only. React sets the property once on mount and the element manages
its own state from there.

This was app-wide and silent. Settings could not show a merchant their own saved
guardrails, the wizard could not prefill a campaign name, and the calendar's
create-from-slot passed a date that never appeared in the field.

## `s-select` takes its initial value on the option

Not on the select. `<s-option value="x" defaultSelected>` rather than
`<s-select defaultValue="x">`. Easy to get wrong because it renders fine either way — it
just always shows the first option.

## `s-button` has no `name` or `value`

So a form with two submit buttons cannot distinguish them the usual way. The pattern used
throughout this app is a hidden input the buttons set before submitting:

```tsx
<input type="hidden" name="intent" ref={intent} value="dry-run" readOnly />
<s-button type="button" onClick={() => submitWith("commit")}>…</s-button>
```

One form rather than two, because both actions read the same fields and duplicating them
would let them drift apart.

## `s-table` blanks the whole page past a few hundred cells

Not the table — the page. No error, and no console message, because the app's console
lives in a cross-origin iframe. Found by bisection: five rows fine, fifty-six not.

Encoded as a cell budget in `app/lib/ui/table-budget.ts`, so a view that grows columns
loses rows rather than losing the page.

## A native `<form>` breaks the embedded session

A plain `<form>` — GET or POST — does a full navigation that wipes App Bridge's `host`,
`id_token` and `shop` parameters. The server then logs `shop: null` and the merchant sees
a blank page. Use `FilterForm` for GET or React Router's `<Form>` for POST.

## `*.server.ts` is stripped from the client bundle

Calling something from one in a component gives `undefined` at click time with no build
error. Hit three times before it stuck: rollback CSV, activity CSV, `describeActor`.
