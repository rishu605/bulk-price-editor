# Issue tracker: GitHub

Issues for this repo live in GitHub Issues on `rishu605/bulk-price-editor`. Use the `gh`
CLI for everything; it infers the repo from `git remote -v`.

**The rules for what an issue is and how it's labelled are in
[`docs/working-agreement.md`](../working-agreement.md). That file wins if this one
disagrees.** What follows is how skills apply them.

## Creating an issue ("publish to the issue tracker")

- ```shell
  gh issue create --title "…" --body-file <file> \
    --label <type> --label area:<x> --label prio:<y> [--label correctness] [--label needs-decision]
  ```
- **Labels, always:**
  - one type: `bug`, `task`, `subtask`, `epic` or `enhancement`
  - exactly one `area:*`: infra, sync, engine, ui, api, billing, compliance, docs, testing
  - exactly one `prio:*`: `core` (needed for public launch), `launch-plus`, `later`
  - add `correctness` when the work touches a resolver invariant I1–I6 (RFC §4); a bug
    there writes wrong prices to a live storefront
  - add `needs-decision` when blocked on an open decision; also add that decision to
    `docs/decisions.md` under *Open*
  - Run `gh label list` rather than guessing a label.
- **Body, in this order:**
  1. The problem, in one or two sentences a merchant would recognise
  2. Evidence: live reproduction (store, time, what the screen said) or a failing test/run
  3. Cause, with `path/to/file.ts:line` references
  4. `### Acceptance criteria` as `- [ ]` checkboxes that can be ticked unambiguously;
     prose isn't an acceptance criterion
- **Trace it:** reference the PRD requirement (`A-x.y`), RFC section (`§n`) or edge case
  (`En`) it serves. Work that traces to nothing is either missing from the PRD or shouldn't
  be built.
- **Titles** state the observed behaviour as a sentence (e.g. "Revert has no inline size
  limit, so a large revert can outlive its request"), not a component name.
- **Hierarchy:** link tasks under their epic, and subtasks under their task, as GitHub
  sub-issues (see the working agreement). Epics are titled `Epic N — …`.
- Say in the body what surfaced new work found mid-phase.

## Reading ("fetch the relevant ticket")

- `gh issue view <number> --comments`, then fetch labels with `--json labels`
- List, with `--label` / `--state` filters:
  ```shell
  gh issue list --state open --json number,title,body,labels,comments \
    --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'
  ```
- Search before filing: `gh issue list --state all --search "<terms>"`. Add evidence to an
  existing issue as a comment rather than opening a duplicate.

## Updating

- Comment: `gh issue comment <number> --body-file <file>`
- Labels: `gh issue edit <number> --add-label … / --remove-label …`
- Close: `gh issue close <number> --comment "…"`. A **scope cut** also gets a line in
  `docs/decisions.md` if the work was previously committed. **Never delete an issue**; the
  record of what was considered is kept.

## Shipping a change (issue → PR → merge)

1. An issue exists first.
2. Branch, commit with `Closes #N` in the body, push, `gh pr create`. Before pushing,
   `rm -rf node_modules/.cache/eslint`: `npm run lint` is cached, and can pass locally on
   a file CI rejects.
3. Wait for all three checks (typecheck/lint/build, chaos scenarios, GitGuardian) and read
   the **exit status**, not the output:
   ```shell
   gh pr checks <n> --watch --fail-fast >/dev/null; echo $?
   ```
   `--fail-fast` returns while the passing checks are still in the tail, and nothing on
   `main` blocks a red merge, so this is the only gate.
4. `gh pr merge --squash --delete-branch`.
5. Railway deploys `main`. Open the pages the change touched in the admin and look at them.
