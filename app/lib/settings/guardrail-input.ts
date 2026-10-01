/**
 * Checking the guardrail numbers a merchant typed, before any of them is saved (#739).
 *
 * `parseSettings` clamps whatever it is given into range, which is right for reading a
 * stored value and wrong for a save: "150" in Minimum margin was saved as 99.9 -- a floor
 * of a thousand times cost -- under "Settings saved.", and the next 20%-off draft priced
 * a $68.86 jacket at $36,160.01. Someone typing 150 into a margin box has made a typo,
 * not asked for the most extreme legal value. A word instead of a number took the same
 * path to `null` and switched the guardrail off without saying so.
 *
 * So a save is refused, naming each field and what it accepts, and nothing is written.
 */

export interface GuardrailInputProblem {
  field: "minMarginPercent" | "minPrice";
  message: string;
}

/** The largest margin floor accepted: a price of at least cost ÷ 0.001. */
export const MAX_MARGIN_PERCENT = 99.9;

type Read = (name: string) => FormDataEntryValue | null;

/** Everything wrong with the typed guardrails, or an empty list. Blank means "none". */
export function guardrailInputProblems(read: Read, currency: string): GuardrailInputProblem[] {
  const problems: GuardrailInputProblem[] = [];

  const margin = text(read("minMarginPercent"));
  if (margin !== "") {
    const value = Number(margin);
    if (!Number.isFinite(value) || value < 0 || value > MAX_MARGIN_PERCENT) {
      problems.push({
        field: "minMarginPercent",
        message: `Minimum margin (%) must be a number from 0 to ${MAX_MARGIN_PERCENT}, or blank for none. “${margin}” is not.`,
      });
    }
  }

  const floor = text(read("minPrice"));
  if (floor !== "") {
    const value = Number(floor);
    if (!Number.isFinite(value) || value < 0) {
      problems.push({
        field: "minPrice",
        message: `Minimum price (${currency}) must be zero or more, or blank for none. “${floor}” is not.`,
      });
    }
  }

  return problems;
}

function text(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
