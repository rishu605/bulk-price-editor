# Triage labels

The skills speak in five canonical triage roles. This maps them to this repo's labels.

| Role in mattpocock/skills | Label in this repo | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | A maintainer needs to evaluate it: labels, priority and acceptance criteria not yet confirmed |
| `needs-info` | `question` | Waiting on the reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified; an agent can pick it up with no human context |
| `ready-for-human` | `ready-for-human` | Needs a human: judgement, credentials, a store action or a product call |
| `wontfix` | `wontfix` | Won't be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the label in
the middle column.

## Rules that keep the house labels intact

- Triage adds and removes **only** the five state labels above. It never changes the type
  label, `area:*`, `prio:*`, `correctness` or `epic` membership. If one of those looks
  wrong, say so in a comment.
- An issue can't be `ready-for-agent` without exactly one `area:*`, one `prio:*`, a
  `### Acceptance criteria` checklist, and a trace to `A-x.y` / `§n` / `En`
  ([`working-agreement.md`](../working-agreement.md)).
- A `correctness` issue is `ready-for-agent` only when its acceptance criteria name the
  invariant (I1–I6, RFC §4) and the test that proves it.
- `needs-decision` is **not** `needs-info`. It means blocked on an open row in
  `docs/decisions.md`, and it keeps an issue out of `ready-for-*` until the decision
  closes.
- `wontfix` closes with a comment giving the reason. If the work was previously committed,
  the scope cut is also recorded in `docs/decisions.md`.
