/**
 * What happened to each email, kept and said back (#1121, #1123).
 *
 * `notify` decides between sending and five reasons not to, and the decision used to exist
 * only as a log line, or not at all. App Review reverted a campaign "to trigger the email",
 * none came, and nothing in the app could say why: the install could not send. Requirement
 * 2.1.4 asks for data to agree across the admin, the app and the platforms the app depends
 * on, and the mail provider is one of those.
 *
 * Each outcome is an audit entry, beside the `notification.drift` and `notification.digest`
 * entries already there: deleted with the shop on `shop/redact`, listed in Activity, and
 * needing no table of its own. Counts and names only -- never a price, a subject or a body.
 */

import { formatWhen } from "../format/display";
import { choiceLabel, preferenceFor } from "./choices";
import type { Notification, NotificationKind } from "./templates";

/** The audit action every `notify` outcome is recorded under. */
export const NOTIFICATION_DELIVERY = "notification.delivery";

export type DeliveryOutcome = "sent" | "unconfigured" | "no-recipient" | "muted" | "failed";

export interface Delivery {
  kind: NotificationKind;
  outcome: DeliveryOutcome;
  /** The campaign's name when it was sent, for a sentence that does not need a lookup. */
  campaign: string | null;
  /** Where it went, or would have gone. Null when no address was saved. */
  to: string | null;
  /** The mail provider's HTTP status, when it refused. */
  status: number | null;
  /** The run it reported on, for the campaign page's run history. */
  runId: string | null;
  /** When, as an ISO string. */
  at: string;
}

const KINDS: ReadonlySet<string> = new Set<NotificationKind>([
  "run-completed",
  "run-partial",
  "run-failed",
  "revert-completed",
  "drift-hold",
  "weekly-digest",
  "test",
]);
const OUTCOMES: ReadonlySet<string> = new Set<DeliveryOutcome>(["sent", "unconfigured", "no-recipient", "muted", "failed"]);

/**
 * What is stored as the entry's `after`. Absent fields are left out rather than stored as
 * null: Activity lists every key, and "status: —, runId: —" on every sent email is noise.
 */
export function deliveryEntry(
  notification: Notification,
  outcome: DeliveryOutcome,
  detail: { to?: string | null; status?: number; runId?: string },
): Record<string, string | number> {
  const entry: Record<string, string | number> = { kind: notification.kind, outcome };
  if ("campaignName" in notification) entry.campaign = notification.campaignName;
  if (detail.to) entry.to = detail.to;
  if (detail.status !== undefined) entry.status = detail.status;
  if (detail.runId) entry.runId = detail.runId;
  return entry;
}

/** A stored entry read back, or null for one this module did not write. */
export function readDelivery(after: unknown, createdAt: Date | string): Delivery | null {
  if (!after || typeof after !== "object" || Array.isArray(after)) return null;
  const value = after as Record<string, unknown>;
  if (typeof value.kind !== "string" || !KINDS.has(value.kind)) return null;
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return null;

  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
  return {
    kind: value.kind as NotificationKind,
    outcome: value.outcome as DeliveryOutcome,
    campaign: text("campaign"),
    to: text("to"),
    status: typeof value.status === "number" ? value.status : null,
    runId: text("runId"),
    at: new Date(createdAt).toISOString(),
  };
}

/** What the email was about: `"Summer sale" was reverted`. */
function subjectOf(delivery: Delivery): string {
  const name = delivery.campaign ? `“${delivery.campaign}”` : "a campaign";
  switch (delivery.kind) {
    case "run-completed":
      return `${name} finished`;
    case "run-partial":
      return `${name} finished partially`;
    case "run-failed":
      return `${name} could not finish`;
    case "revert-completed":
      return `${name} was reverted`;
    case "drift-hold":
      return `prices in ${name} were changed outside Anchor`;
    case "weekly-digest":
      return "the weekly summary";
    case "test":
      return "a test email";
  }
}

/** Why nothing went out, as the end of a sentence. */
function reasonOf(delivery: Delivery): string {
  switch (delivery.outcome) {
    case "unconfigured":
      return "Anchor couldn't send email at the time";
    case "no-recipient":
      return "no address was saved";
    case "muted": {
      const key = preferenceFor(delivery.kind);
      return key ? `“${choiceLabel(key)}” is switched off` : "it was switched off";
    }
    case "failed":
      return `the mail provider refused it${delivery.status ? ` (status ${delivery.status})` : ""}`;
    case "sent":
      return "";
  }
}

/**
 * Where emails go, as stored, for Settings to read back after every save (#1119). The field
 * shows what was typed, which looks the same before a save and after one.
 */
export function savedAddressLine(email: string | null): string {
  return email ? `Emails go to ${email}.` : "No address saved, so no emails are sent.";
}

/**
 * Settings → Notifications' account of the last email, from the most recent first.
 *
 * Two lines rather than one "last outcome": the newest outcome is most often a muted one --
 * an apply, with "A run finished cleanly" off by default -- and "Last email not sent" after
 * every apply would read as a fault. So the last email that went out, and beside it the
 * newest one that should have and did not, when there is one. A muted email is the
 * merchant's own choice, not a problem, and is never the second line.
 */
export function lastEmailLines(
  newestFirst: readonly Delivery[],
  timeZone: string,
): { sent: string; problem: string | null } {
  const sentIndex = newestFirst.findIndex((delivery) => delivery.outcome === "sent");
  const last = sentIndex === -1 ? null : newestFirst[sentIndex]!;
  const problem = newestFirst
    .slice(0, sentIndex === -1 ? undefined : sentIndex)
    .find((delivery) => delivery.outcome !== "muted" && delivery.outcome !== "sent");

  return {
    sent: last
      ? `Last email: ${subjectOf(last)}, sent to ${last.to} on ${formatWhen(last.at, timeZone)}.`
      : "No email has been sent yet.",
    problem: problem
      ? `Not sent: ${subjectOf(problem)}, on ${formatWhen(problem.at, timeZone)}, because ${reasonOf(problem)}.`
      : null,
  };
}

/**
 * One run's email, for its row in the run history. Null for a run with no record, which is
 * every run from before the record existed: a dash, rather than a guess.
 */
export function runEmailLine(delivery: Delivery | undefined): { text: string; toSettings: boolean } | null {
  if (!delivery) return null;
  switch (delivery.outcome) {
    case "sent":
      return { text: `Emailed ${delivery.to}`, toSettings: false };
    // The two the merchant can change, so the row links to where they change it.
    case "muted":
    case "no-recipient":
      return { text: `No email: ${reasonOf(delivery)}`, toSettings: true };
    case "unconfigured":
      return { text: `No email: ${reasonOf(delivery)}`, toSettings: false };
    case "failed":
      return { text: `Not delivered: ${reasonOf(delivery)}`, toSettings: false };
  }
}
