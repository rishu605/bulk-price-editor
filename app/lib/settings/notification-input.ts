/**
 * Checking the notification address a merchant typed, before anything is saved (#1120).
 *
 * `parsePreferences` reads anything without an "@" as no address, which is right for a
 * value read back from storage and wrong for a save: "ops" was saved as nothing under
 * "Settings saved.", the field went on showing "ops" until a reload, and the merchant
 * believed emails were on. Two addresses with a comma between them were saved whole, and
 * every send was then refused by the mail provider, where nobody would see it.
 *
 * So, like the guardrails (#739), a save is refused with the field named, and nothing is
 * written.
 */

/** The field's label, shared by the field and its refusal. */
export const SEND_TO_LABEL = "Send to";

/**
 * One address: something, an "@", and a domain with a dot in it. Not RFC 5322 -- the mail
 * provider is the real judge -- but enough to refuse a typo, and anything that is several
 * addresses or a display name.
 */
const ONE_ADDRESS = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()".]{2,}$/;

/** Several addresses, however they were separated. */
const SEVERAL = /[,;]|@.*@/;

/** A typed address: null for blank (notifications off), the address, or undefined when it is neither. */
export function notificationEmailFrom(value: FormDataEntryValue | null): string | null | undefined {
  const typed = typeof value === "string" ? value.trim() : "";
  if (typed === "") return null;
  return ONE_ADDRESS.test(typed) ? typed : undefined;
}

export interface NotificationInputProblem {
  field: "email";
  message: string;
}

/** What is wrong with the typed address, or an empty list. A form without the field has nothing wrong. */
export function notificationInputProblems(read: (name: string) => FormDataEntryValue | null): NotificationInputProblem[] {
  const value = read("email");
  if (value === null || notificationEmailFrom(value) !== undefined) return [];

  const typed = String(value).trim();
  return [
    {
      field: "email",
      message: SEVERAL.test(typed)
        ? `${SEND_TO_LABEL} takes one address, and “${typed}” is more than one. Enter one, such as a shared inbox, or leave it blank to turn emails off.`
        : `${SEND_TO_LABEL} must be an email address, such as ops@yourshop.com, or blank to turn emails off. “${typed}” is not.`,
    },
  ];
}
