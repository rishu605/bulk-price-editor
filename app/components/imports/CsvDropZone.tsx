import { useState } from "react";

import { countOf } from "../../lib/format/display";
import { SPACE } from "../../lib/ui/spacing";
import { LiveStatus } from "../LiveStatus";

/**
 * Dropping a CSV file instead of opening it and pasting its contents.
 *
 * All three imports took pasted text and nothing else, so a merchant who had just
 * exported a file from Shopify or a spreadsheet had to open it in a text editor first.
 * That is a strange thing to ask of someone whose next action is a price change across
 * their catalogue, and it is the step where people give up.
 *
 * The file is read in the browser and put into the textarea the form already submits.
 * Deliberately: the server action, its parsing, its dry run and its error reporting are
 * unchanged, and a merchant who prefers to paste — or who is fixing three rows by hand
 * after a failed dry run — still can. The drop zone adds a way in; it does not become
 * the only one.
 *
 * Nothing is uploaded. The file never leaves the browser as a file, which also means a
 * 40,000-row catalogue export does not become a multipart request.
 */
export function CsvDropZone({
  /** The textarea this fills. Must be the field the form submits. */
  target,
  label = "Drop a CSV file",
}: {
  target: string;
  label?: string;
}) {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);

    try {
      const text = await file.text();
      const field = document.querySelector<HTMLTextAreaElement>(`[name="${target}"]`);
      if (!field) {
        // The drop zone is useless without somewhere to put the text, and silently
        // doing nothing would look like the file was rejected.
        setProblem("Could not find the text box to fill. Paste the file's contents instead.");
        return;
      }

      field.value = text;
      // Polaris components own their value, so assigning to it is not enough — the
      // element has to be told, or the form submits the box the merchant can see as
      // full and the server receives it empty.
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));

      setLoaded({ name: file.name, lines: text.split("\n").filter((l) => l.trim()).length });
    } catch {
      setProblem(`Could not read ${file.name}. Open it and paste its contents instead.`);
    }
  };

  return (
    <CsvDropZoneView label={label} loaded={loaded} problem={problem} onFile={(file) => void read(file)} />
  );
}

/** A file that landed: its name, and how many non-blank lines it put in the box. */
export interface LoadedFile {
  name: string;
  lines: number;
}

/** The sentence a landed file earns, on screen and aloud. */
function loadedSentence(loaded: LoadedFile): string {
  return `${loaded.name} — ${countOf(loaded.lines, "line")} loaded below. Nothing is imported until you run it.`;
}

/**
 * The drop zone as drawn, from what has happened to it so far.
 *
 * Apart from the reading so it can be rendered in a test without a file: what a merchant
 * sees and hears after a drop is the part that went wrong (#798), and all of it is here.
 */
export function CsvDropZoneView({
  label = "Drop a CSV file",
  loaded,
  problem,
  onFile,
}: {
  label?: string;
  loaded: LoadedFile | null;
  problem: string | null;
  onFile: (file: File | undefined) => void;
}) {
  return (
    // The zone and the line reporting what landed in it are one object, so they sit at
    // item rhythm. `small-200` was a step off the scale entirely — between item and
    // tight, and therefore telling the reader nothing either of them would have.
    <s-stack gap={SPACE.item}>
      <s-drop-zone
        label={label}
        accept=".csv,text/csv,text/plain"
        // On the control, not in a paragraph after it (#798). The paragraph was tied to
        // nothing, so a screen reader on the drop zone had no way to learn it had failed,
        // and the zone's own error slot sat empty.
        error={problem ?? undefined}
        // `files` is a File[], not a FileList — the Polaris element hands back an array.
        onChange={(event) => onFile(event.currentTarget.files?.[0])}
      />
      {/* Said as well as shown. Choosing a file takes focus to the system's file dialog
          and back, and the line below appears while the merchant is somewhere else: a
          screen reader user was never told the box had filled, or that it had not. A
          failure is said here too, because an error on a field is read when the field is
          focused, not when it appears. */}
      <LiveStatus message={problem ?? (loaded ? loadedSentence(loaded) : "")} />
      {loaded ? (
        <s-paragraph>
          <s-text tone="success">{loadedSentence(loaded)}</s-text>
        </s-paragraph>
      ) : null}
    </s-stack>
  );
}
