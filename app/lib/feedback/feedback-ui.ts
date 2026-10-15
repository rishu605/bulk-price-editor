/**
 * What the feedback form says, shared by the form and the history beneath it (#743).
 */

export type FeedbackKind = "problem" | "idea" | "praise";

/** The select's own words, so the history reads them back rather than `problem`. */
export const KIND_LABELS: Record<FeedbackKind, string> = {
  problem: "Something is wrong",
  idea: "An idea",
  praise: "Something worked well",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as FeedbackKind] ?? kind;
}

const KEY = "anchor.lastScreen";
export const FEEDBACK_PATH = "/app/settings/feedback";

function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The screen a merchant was on before Feedback, kept so the report can say where the
 * problem was (#743). The form exists only on the Feedback page, which recorded itself as
 * the screen every time. Path only: the query string carries App Bridge's token.
 */
export function rememberScreen(pathname: string, storage: Pick<Storage, "setItem"> | null = session()): void {
  if (pathname.startsWith(FEEDBACK_PATH)) return;
  try {
    storage?.setItem(KEY, pathname);
  } catch {
    // Storage refused (a private window): the report goes without a screen, and says so.
  }
}

/** The screen before Feedback, or null when there is none to tell. */
export function lastScreen(storage: Pick<Storage, "getItem"> | null = session()): string | null {
  try {
    return storage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}
