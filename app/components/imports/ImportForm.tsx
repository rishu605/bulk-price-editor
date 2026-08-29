import type { ReactNode } from "react";
import { Blank } from "../Blank";
import { useRef } from "react";
import type { FetcherWithComponents } from "react-router";

import { ActionRow } from "../ActionRow";
import { CountsRow } from "../CountsRow";
import { EmptyState } from "../AsyncState";
import { CsvDropZone } from "./CsvDropZone";
import { UnsavedChanges } from "../UnsavedChanges";
import { downloadCsv } from "../../lib/reporting/csv";
import { SPACE } from "../../lib/ui/spacing";

/**
 * One CSV import, whatever the file is for.
 *
 * Prices, baselines and costs were three copies of this: two intro paragraphs, a drop
 * zone, an `s-text-area` named `csv`, an inline stack of a "check" button and an "import"
 * button driven by the same hidden `intent` field, then a report of counts and problem
 * rows. Written a few tickets apart, and already visibly apart:
 *
 * | | prices | baselines | costs |
 * |---|---|---|---|
 * | commit is a critical button | no | yes | yes |
 * | commit blocked until a dry run | **no** | yes | **no** |
 * | problems shown as | a bullet list | a table | a bullet list |
 * | counts sentence | **none** | four numbers | five numbers |
 * | errors downloadable | **no** | yes | yes |
 *
 * The middle row is the one that matters. "You cannot commit before you have checked"
 * existed on exactly one of the three paths that write to a merchant's catalogue, and
 * nothing said the other two were different on purpose. It is here now, so all three have
 * it and none of them can lose it separately.
 *
 * ## What is still per-source
 *
 * The words, the sample rows, and what the file does when it lands — passed in. The
 * shape, the guard, and the order of the two buttons are not.
 */
/**
 * The bare pair, for a page whose only check-then-commit is the import.
 *
 * Exported so a route reads its action back with the same constant it rendered, rather
 * than with a string literal that can drift from it by one character.
 */
export const INTENT = { check: "dry-run", commit: "commit" } as const;

export function ImportForm({
  heading,
  description,
  placeholder,
  fetcher,
  busy,
  checkLabel = "Check the file",
  commitLabel,
  ready,
  intent = INTENT,
  action,
  template,
  children,
}: {
  heading: string;
  /** What this file is, and what happens when it lands. */
  description: ReactNode;
  /** Sample rows, shown in the empty textarea. */
  placeholder: string;
  fetcher: FetcherWithComponents<unknown>;
  busy: boolean;
  checkLabel?: string;
  /** Says how many rows will be written, which is why it takes the count. */
  commitLabel: (ready: number) => string;
  /**
   * Rows the last dry run found ready, or `null` if it has not run.
   *
   * The commit button is disabled until this is a positive number. Not because pressing
   * it would break anything — the action defaults to a dry run on a missing or
   * unrecognised intent — but because "import 0 rows" is a button that reports success
   * for having done nothing, and a merchant who has not looked at the report is exactly
   * the merchant who should not be writing to their catalogue.
   */
  ready: number | null;
  /**
   * The two values this form's `intent` field can take.
   *
   * Namespaced when the page already runs a check-then-commit of its own — the cost
   * import shares a route with the bulk cost editor, and one `intent` field cannot mean
   * two things. The route reads it back with `isCommit(value, intent.commit)`.
   */
  intent?: { check: string; commit: string };
  /**
   * Where to post, when that is not the route this form is rendered on.
   *
   * The campaign editor offers a spreadsheet as one of the ways prices change, and the
   * whole point of doing it that way is that the import's action, parsing, dry run and
   * error reporting are untouched — so the form still posts to `/app/campaigns/import`
   * from wherever it is shown.
   */
  action?: string;
  /**
   * A starter file, offered beside the drop zone.
   *
   * All three competitors give one, and it is the difference between "paste a CSV" and
   * a merchant guessing at column names. Omitted where a source has no template yet
   * rather than linking to one that does not exist.
   */
  template?: { href: string; label: string };
  /** Extra fields this source needs, above the file. */
  children?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const submitWith = (value: string) => {
    if (field.current) field.current.value = value;
    form.current?.requestSubmit();
  };

  return (
    <s-section heading={heading}>
      {/* A pasted CSV can be fifty thousand rows, and none of it exists anywhere until
          the import runs. */}
      <UnsavedChanges form={form} describe="this import" saved={Boolean(fetcher.data)} />

      {description}

      <fetcher.Form method="post" action={action} ref={form}>
        {/* `s-button` takes no name or value, so the intent rides in a hidden field the
            buttons set before submitting. One form rather than two, because both actions
            read the same rows and duplicating the textarea would let them drift apart —
            which is the mistake this component exists to undo at a larger scale. */}
        <input type="hidden" name="intent" ref={field} value={intent.check} readOnly />
        <s-stack gap={SPACE.section}>
          {children}
          <CsvDropZone target="csv" />

          {/* Beside the drop zone, not in the prose above it. Somebody who has got as far
              as looking for where to put a file is the person who needs the column names,
              and a link three paragraphs up has already been scrolled past. */}
          {template ? (
            <ActionRow>
              {/* `download=""`, not `download`. The Polaris button types the attribute
                  as a string — the filename to save as — and a bare boolean does not
                  typecheck; empty means "use the name the server sends". */}
              <s-button variant="tertiary" icon="download" href={template.href} download="">
                {template.label}
              </s-button>
            </ActionRow>
          ) : null}

          <s-text-area
            name="csv"
            label="Rows"
            rows={12}
            placeholder={placeholder}
            details="Paste straight from a spreadsheet, or drop a file above. A header row is read if there is one."
          />

          <ActionRow>
            <s-button
              type="button"
              variant="primary"
              loading={busy || undefined}
              onClick={() => submitWith(intent.check)}
            >
              {checkLabel}
            </s-button>
            <s-button
              type="button"
              tone="critical"
              loading={busy || undefined}
              disabled={!ready || undefined}
              onClick={() => submitWith(intent.commit)}
            >
              {commitLabel(ready ?? 0)}
            </s-button>
          </ActionRow>
        </s-stack>
      </fetcher.Form>
    </s-section>
  );
}

/** A row this import could not use, and why. */
export interface ImportProblem {
  line: number;
  identifier: string;
  reason: string;
  /** What kind of problem, for sources that distinguish them. */
  kind?: string;
}

/**
 * What the file would do, or did.
 *
 * The counts first, as tiles, for the same reason the campaign preview shows them that
 * way: they are the summary of what is about to happen to a live catalogue, and as a run
 * of text — "412 rows read · 9 ready · 3 need attention" — the reader has to parse it
 * into pairs themselves. Prices showed no counts at all.
 *
 * Problems as a table rather than a bullet list. Two of the three used a list, which puts
 * the line number, the identifier and the reason into one sentence per row, so nothing
 * lines up and a file with twenty bad rows cannot be scanned for the one thing they have
 * in common — which is the question a merchant looking at this list is asking.
 */
export function ImportReport({
  heading,
  counts,
  problems,
  download,
  limit = 25,
}: {
  heading: string;
  counts: Array<{ label: string; value: number }>;
  problems: ImportProblem[];
  /**
   * Every problem row, not just the ones the table shows.
   *
   * A thunk rather than a string: a file with forty thousand bad rows should not have its
   * error CSV built on every render of the page that offers it.
   */
  download?: { filename: string; csv: () => string };
  limit?: number;
}) {
  return (
    <s-section heading={heading}>
      <CountsRow items={counts} />

      {problems.length === 0 ? (
        <EmptyState
          title="Every row matched a variant and validated"
          description="Nothing was left out, so the counts above account for the whole file."
        />
      ) : (
        <>
          <s-paragraph>
            <s-text>
              These rows were left out. Everything else is unaffected — one bad row never
              fails the file.
            </s-text>
          </s-paragraph>

          {download ? (
            <ActionRow>
              <s-button
                type="button"
                variant="tertiary"
                icon="download"
                onClick={() => downloadCsv(download.filename, download.csv())}
              >
                Download all {problems.length} (CSV)
              </s-button>
            </ActionRow>
          ) : null}

          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="kicker" format="numeric">Line</s-table-header>
              <s-table-header listSlot="primary">Identifier</s-table-header>
              <s-table-header listSlot="inline">Problem</s-table-header>
              <s-table-header listSlot="secondary">What to do</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {problems.slice(0, limit).map((problem) => (
                <s-table-row key={`${problem.line}-${problem.identifier}-${problem.reason}`}>
                  <s-table-cell>{problem.line}</s-table-cell>
                  <s-table-cell>{problem.identifier || <Blank />}</s-table-cell>
                  <s-table-cell>{problem.kind ?? "Will not import"}</s-table-cell>
                  <s-table-cell>{problem.reason}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>

          {problems.length > limit ? (
            <s-paragraph>
              <s-text color="subdued">
                Showing the first {limit} of {problems.length}.
                {download ? " The download has all of them." : ""}
              </s-text>
            </s-paragraph>
          ) : null}
        </>
      )}
    </s-section>
  );
}
