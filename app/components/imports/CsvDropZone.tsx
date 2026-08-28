import { useState } from "react";

import { SPACE } from "../../lib/ui/spacing";

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
  const [loaded, setLoaded] = useState<{ name: string; lines: number } | null>(null);
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
    // The zone and the line reporting what landed in it are one object, so they sit at
    // item rhythm. `small-200` was a step off the scale entirely — between item and
    // tight, and therefore telling the reader nothing either of them would have.
    <s-stack gap={SPACE.item}>
      <s-drop-zone
        label={label}
        accept=".csv,text/csv,text/plain"
        // `files` is a File[], not a FileList — the Polaris element hands back an array.
        onChange={(event) => void read(event.currentTarget.files?.[0])}
      />
      {loaded ? (
        <s-paragraph>
          <s-text tone="success">
            {loaded.name} — {loaded.lines} line{loaded.lines === 1 ? "" : "s"} loaded below.
            Nothing is imported until you run it.
          </s-text>
        </s-paragraph>
      ) : null}
      {problem ? (
        <s-paragraph>
          <s-text tone="critical">{problem}</s-text>
        </s-paragraph>
      ) : null}
    </s-stack>
  );
}
