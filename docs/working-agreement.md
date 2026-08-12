# Working agreement

How the issue tracker maps to the planning docs, and the rules for changing either.

## Issue hierarchy

```
Milestone (phase)     P0 … P6 — when
   └─ Epic            E1 … E13 — durable feature area, spans phases
        └─ Task       P0.1, P1.4, … — one roadmap line, <=3 days
             └─ Subtask  P0.1.1, … — a single unit of work
```

Epics and milestones are **orthogonal on purpose**. A milestone answers *when*; an epic answers
*what part of the system*. Epic 5 (job engine) has tasks in P2, P3 and P4 — filtering the
board by epic shows a coherent subsystem, filtering by milestone shows a shippable increment.

Tasks are linked to their epic, and subtasks to their task, using GitHub's native
sub-issue relationships — so an epic shows live progress as its children close.

**Subtasks exist for P0–P2 only.** Those phases are immediately actionable and worth
decomposing now. P3–P6 tasks carry full acceptance-criteria checklists in their bodies and
get broken into subtasks when their phase starts — decomposing work that far out mostly
produces subtasks you delete later.

## Labels

| Label | Meaning |
|---|---|
| `epic` / `task` / `subtask` | Level in the hierarchy |
| `area:*` | Subsystem — infra, sync, engine, ui, api, billing, compliance, docs, testing |
| `prio:core` | Required for public launch |
| `prio:launch-plus` | Fast-follow after launch |
| `prio:later` | Validate demand before building |
| `correctness` | **Touches an invariant. A bug here writes wrong prices to a live storefront.** |
| `needs-decision` | Blocked on an open decision in [`decisions.md`](decisions.md) |

The `correctness` label is the one to take seriously. It marks work covered by the resolver
invariants (RFC §4) — changes there need property tests, not just a passing build.

## Rules

**The docs are the source of truth; issues are the execution view.** If an issue and a doc
disagree, the doc wins — or the doc is wrong and should be fixed in the same PR. Never let
an issue silently redefine a requirement.

**Every task traces to a requirement.** Task bodies reference PRD requirement IDs (`A-x.y`),
RFC sections (`§n`) or edge cases (`En`). A task that traces to nothing is either missing
from the PRD or should not be built.

**Acceptance criteria are checkboxes, not prose.** If it cannot be checked off
unambiguously, it is not an acceptance criterion.

**Closing a phase means closing its milestone.** The exit criteria are on the milestone
description. A milestone with open `prio:core` issues is not done, whatever the calendar says.

## Changing scope

- **New work discovered mid-phase** — open a task, link it to the right epic and milestone,
  and say in the body what surfaced it.
- **A decision needs making** — add `needs-decision`, and add the decision to
  [`decisions.md`](decisions.md) under Open with the phase that resolves it.
- **Scope cut** — close the issue with a comment explaining why, and record it in
  `decisions.md` under "Reversed during planning" if it was previously committed. Do not
  delete issues; the record of what was considered and dropped is worth keeping.
