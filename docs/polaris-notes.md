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

## `s-table` picks grid-or-list itself, and App Home has no `variant="table"`

The base types offer `variant: 'list' | 'table' | 'auto'`. The **App Home** surface then
narrows it — `TableProps.variant` is `Extract<..., 'list' | 'auto'>` — so `"table"` does
not compile, and there is no way to pin the grid. Shopify said the same thing about the
other end in the forums: on mobile the list variant is forced whatever you pass.

`auto` collapses to the stacked layout somewhere around a 490px container. That is not the
trap. The trap is that a container *close* to it resolves inconsistently: the campaigns
list sits at ~566px next to a 22rem aside, and the same URL in the same window renders a
grid on one reload and a stacked list on the next. Flooring the column's `minInlineSize`
does not change it, so whatever Polaris measures is not the column we give it.

Since the shape cannot be pinned, **both shapes have to be worth looking at**. Every
`s-table-header` takes `listSlot` — `primary | secondary | kicker | inline | labeled` —
and it defaults to `labeled`, which is why an undesignated table collapses into a wall of
"Priority 900" pairs with the row's own name carrying no more weight than its rank. Name
the primary column and the collapsed form reads as a list row. `format="numeric"` on the
same element right-aligns a number in the grid.

`format` is the other half and is easy to miss: `currency` and `numeric` both
right-align a column, and a price column that does not is a price column that will not
line up on the decimal with the one beside it. On the catalogue page four of them sit
together.

Every table in the app is designated now, and `app/lib/ui/table-designation.test.ts`
keeps it that way. Two of its rules are not stylistic:

- **One `primary` per table.** Polaris takes the last of any others, so a second one
  silently unslots a column rather than failing.
- **`kicker` comes before `primary` in the collapsed form**, so a column designated
  `kicker` must also be written first in the header row and first in each body row, or
  the grid and the list disagree about the order. Reconciliation (surface before
  product), Activity (when before what), Imports (when before file) and Diagnostics
  (when before reference) all had their cells reordered to match, which is a change to
  the *grid* made for the list's benefit — worth knowing before someone "fixes" it back.

## A native `<form>` breaks the embedded session

A plain `<form>` — GET or POST — does a full navigation that wipes App Bridge's `host`,
`id_token` and `shop` parameters. The server then logs `shop: null` and the merchant sees
a blank page. Use `FilterForm` for GET or React Router's `<Form>` for POST.

## `*.server.ts` is stripped from the client bundle

Calling something from one in a component gives `undefined` at click time with no build
error. Hit three times before it stuck: rollback CSV, activity CSV, `describeActor`.

A fourth, with the opposite symptom: importing a *constant* from one into a component
fails `npm run build` outright — "Server-only module referenced by client" — because React
Router only strips server code from `loader`, `action`, `middleware` and `headers`, and
anything else in the file that references the module drags it into the browser bundle.
Typecheck and vitest both pass. `polaris-traps.test.ts` now rejects a value import from a
`*.server` module anywhere under `app/components`; a `import type` is fine, because types
are erased.

## A table's page size is not its cell budget

Two different limits, and conflating them costs either a blank page or an unreadable one.

`CELL_BUDGET` is the hard one: past a few hundred cells `s-table` blanks the page. It is a
cell count rather than a row count because a preview with three markets has twice the
columns of a base-only one.

`ROWS_PER_VIEW` is the judgement: how many rows a merchant should be shown at once. The
app had six answers to it (50, 25, 100, 200, and two tables that rendered everything), and
three of those had no pager, so the page scrolled for screens with the table's header long
gone off the top.

**There is no scroll container to reach for.** `s-box` takes `overflow: 'hidden' |
'visible'` and nothing else. A native `div` would give up more than it buys: the header row
is inside Polaris' shadow DOM so it could not be made to stick, and `s-table` decides for
itself whether to render a grid or a stacked list — a stacked list inside a fixed-height
scroller is not a design anybody chose. Cap the rows and page instead.

**`s-table` has `filters` and pagination props of its own.** `filters` is a slot (like
`details` on `s-choice`), and `paginate`/`hasNextPage`/`onNextPage` render Polaris' own
pager. Neither is used yet, and the filters slot has a real flaw: it lives inside the
table, so it unmounts when the table has no rows — which is exactly when a merchant wants
the search box.
