/**
 * Numbering a form's sections, when the form is not always the same length.
 *
 * The campaign editor is a numbered sequence — "1 · Rule", "2 · Scope" — and it is about
 * to stop having a fixed number of steps: a campaign priced from a file has no scope to
 * choose, because the file is the scope, so that section will not be rendered at all
 * (#445). NA does exactly this and it reads as the form being only as long as the choice
 * requires.
 *
 * Hardcoding the numbers means the day a section is dropped the merchant reads "1 · Rule"
 * followed by "3 · Schedule" and wonders what they missed. Numbering what is present is
 * one line and cannot do that.
 */

/** A section that may or may not be part of this form. */
export interface SectionSpec {
  /** Stable name, so a caller can look its heading up without counting. */
  key: string;
  title: string;
  /** Absent or true renders it; false leaves it out and closes the numbering up. */
  when?: boolean;
}

/**
 * Headings for the sections that apply, numbered from one in order.
 *
 * Returns a lookup rather than an array because the caller renders each section in its
 * own place in the JSX: asking for `headings.rule` reads better at the call site than
 * indexing a list, and it cannot silently pick up the wrong heading when the order
 * changes.
 */
export function numberSections(sections: SectionSpec[]): Record<string, string> {
  const headings: Record<string, string> = {};
  let n = 0;

  for (const section of sections) {
    if (section.when === false) continue;
    n += 1;
    headings[section.key] = `${n} · ${section.title}`;
  }

  return headings;
}
