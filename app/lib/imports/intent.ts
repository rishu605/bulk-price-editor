/**
 * Whether a submitted form meant "write this", as opposed to "check it".
 *
 * Every import in this app runs twice: a dry run that reports what would happen, then a
 * commit that does it. Which one a request is comes down to a single form field, and the
 * whole safety of the arrangement rests on that field being read the *safe* way round —
 * `intent === "commit"` rather than `intent === "dry-run"`. An intent that fails to
 * arrive, arrives misspelled, or arrives from a form somebody edited must fall to the
 * side that writes nothing.
 *
 * It was three copies of `String(form.get("intent")) !== "commit"`, one per import route,
 * and a test that grepped each route for that literal. The grep was doing real work — it
 * is the only reason nobody inverted one — but it checks the spelling of a comparison
 * rather than the behaviour of one, so it could not survive the routes moving, and it
 * could never have caught `"Commit"` or a stray space.
 *
 * Now the comparison is here, and the test below exercises it with the values that would
 * actually turn up.
 *
 * ## Why the value is a parameter
 *
 * Two of these forms now share a route with something else that also runs check-then-
 * commit: the cost import sits on the page that bulk-edits costs. One `intent` field
 * cannot mean two things, so the import's pair is namespaced (`import-dry-run` /
 * `import-commit`) and the route dispatches on it. The default is the bare pair, so a
 * page with one import reads exactly as it did.
 */
export function isCommit(intent: FormDataEntryValue | null | undefined, commit = "commit"): boolean {
  return typeof intent === "string" && intent === commit;
}
