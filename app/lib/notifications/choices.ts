/**
 * The notifications a merchant can switch on, in the words Settings uses for them.
 *
 * One list, because three places say these sentences: the checkboxes in Settings, the test
 * email that tells the merchant which ones are on (#1122), and a run's "No email: … is
 * switched off" (#1123). Written out three times, one would be reworded and the run page
 * would name a checkbox that no longer exists.
 */

import type { NotificationKind } from "./templates";

/** The preference behind each choice, as stored in `NotificationPreferences`. */
export type PreferenceKey = "onPartialOrFailure" | "onDrift" | "onRevert" | "onCompletion" | "weeklyDigest";

export interface NotificationChoice {
  key: PreferenceKey;
  label: string;
  details?: string;
}

/** In the order Settings shows them: the ones that need a decision first. */
export const NOTIFICATION_CHOICES: readonly NotificationChoice[] = [
  {
    key: "onPartialOrFailure",
    label: "A run did not finish cleanly",
    details: "Something needs you: rows failed, or the run stopped early.",
  },
  {
    key: "onDrift",
    label: "Someone changed a price outside the app",
    details: "Those edits are held for your decision rather than overwritten.",
  },
  { key: "onRevert", label: "A campaign was reverted" },
  {
    key: "onCompletion",
    label: "A run finished cleanly",
    details: "Off by default. Being emailed about every success is how the one email that mattered gets skimmed past.",
  },
  { key: "weeklyDigest", label: "Weekly summary" },
];

/**
 * The preference that decides whether a kind is sent, or null for one that is always
 * wanted. Partial and failed share one: they are the same question to a merchant --
 * something needs me.
 */
export function preferenceFor(kind: NotificationKind): PreferenceKey | null {
  switch (kind) {
    case "run-completed":
      return "onCompletion";
    case "run-partial":
    case "run-failed":
      return "onPartialOrFailure";
    case "revert-completed":
      return "onRevert";
    case "drift-hold":
      return "onDrift";
    case "weekly-digest":
      return "weeklyDigest";
    // Asked for by pressing a button. A merchant who has switched every kind off still
    // wants to know the address works.
    case "test":
      return null;
  }
}

export function choiceLabel(key: PreferenceKey): string {
  return NOTIFICATION_CHOICES.find((choice) => choice.key === key)?.label ?? key;
}

/** The labels of the choices switched on, in Settings' order. */
export function switchedOn(preferences: Record<PreferenceKey, boolean>): string[] {
  return NOTIFICATION_CHOICES.filter((choice) => preferences[choice.key]).map((choice) => choice.label);
}
