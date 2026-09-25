# Domain docs

This is a **single-context** repo. Its domain language and decisions already live in these
files. Read the ones relevant to the area before exploring, in this order:

1. **`CLAUDE.md`**: the architectural rules (baseline not live price, one writer per
   occurrence, ledger before write, preview = execution, verified-clean, revert =
   recompute, integer minor units, no hardcoded rate limits, no theme code). Breaking one
   writes a wrong price to a live storefront.
2. **`docs/rfc-001-architecture.md`**: stack, data model, resolver and its invariants (§4),
   job engine (§5), write paths (§6), sync (§7), rate limits (§8), scheduling (§9).
3. **`docs/prd.md`**: requirements (`A-x.y`, *core* vs *later*) and edge cases (`En`).
4. **`docs/help/concepts/`**: merchant-facing definitions of baseline, resolver, revert,
   drift and rate limits. Use these words in anything a merchant reads.
5. **`docs/decisions.md`**: committed and open decisions (`D1`, `D2`…).
6. **`docs/working-agreement.md`** and **`docs/roadmap.md`**: how work is organised, and
   which phase we're in.
7. For UI: **`docs/polaris-notes.md`**. The embedded admin stays on Polaris web
   components.

## Decisions go in `docs/decisions.md`, never `docs/adr/`

- Don't create `docs/adr/`. Where a skill would write an ADR, add a row to
  `docs/decisions.md` instead: under **Open** with the phase that resolves it (and label
  the blocked issue `needs-decision`), or under **Committed** with its reasoning. Edit a
  row in place when it closes; don't append a second.
- If your output contradicts a decision, say so explicitly rather than silently overriding
  it: *"Contradicts D5 (Railway, web + worker) — worth reopening because…"*

## Glossary (`CONTEXT.md`)

- A root `CONTEXT.md` glossary may be created **lazily** (e.g. by `/grill-with-docs`) when
  a term gets resolved. Each entry is the term, a one-line definition, and where it's
  defined, e.g. **Baseline** — the durable reference price every campaign computes from.
  *Defined in RFC-001 §3; merchant wording in `docs/help/concepts/baselines.md`.*
- The glossary **points at** the RFC and PRD; it doesn't redefine them. If `CONTEXT.md` and
  the RFC/PRD disagree, the RFC/PRD wins ("the docs are the source of truth"). Fix the
  glossary, or fix the doc in the same PR.
- If `CONTEXT.md` doesn't exist yet, proceed with the documents above. Don't flag its
  absence.

## Use the project's vocabulary

In issue titles, proposals, hypotheses and test names, use the terms as the docs define
them: *baseline*, *surface*, *occurrence*, *resolve / resolve(without C)*, *held*, *drift*,
*partial*, *verified clean*, *write-ahead ledger*, *ledger row*. If the concept you need
isn't named anywhere, either you're inventing language (reconsider) or there's a real gap
(note it for `/grill-with-docs`).
