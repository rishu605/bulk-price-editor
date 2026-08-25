/**
 * What the app tells a merchant by email, and what it deliberately does not.
 *
 * Campaigns run for hours. The merchant has to be able to close the tab and still find
 * out what happened, which is the entire reason these exist.
 *
 * The hard constraint is that **no price value ever appears in an email body**. Not
 * the old price, not the new one, not a single variant's. Email is unencrypted in
 * transit to a mailbox the app does not control, forwarded, indexed by mail providers
 * and read on shared screens; a merchant's pricing is commercially sensitive and none
 * of it belongs there. Aggregate counts carry everything an email needs to carry, and
 * the app itself is one click away for anything specific.
 *
 * That is a rule about this module, so it is enforced by a test rather than by care —
 * these functions take counts and names, and are never handed a Money.
 */

export type NotificationKind =
  | "run-completed"
  | "run-partial"
  | "run-failed"
  | "revert-completed"
  | "drift-hold"
  | "weekly-digest";

export interface RunCounts {
  verified: number;
  skipped: number;
  clamped: number;
  failed: number;
  unverified: number;
}

export interface RunNotification {
  kind: Exclude<NotificationKind, "weekly-digest" | "drift-hold">;
  campaignName: string;
  counts: RunCounts;
  /** Merchant-facing reasons, already through the error taxonomy. Never raw errors. */
  reasons?: string[];
  /** Deep link back into the app, where the specifics live. */
  campaignUrl?: string;
}

export interface DriftNotification {
  kind: "drift-hold";
  campaignName: string;
  driftedCount: number;
  campaignUrl?: string;
}

export interface DigestNotification {
  kind: "weekly-digest";
  shopName: string;
  campaignsRun: number;
  variantsChanged: number;
  driftOpen: number;
  partialRuns: number;
}

export type Notification = RunNotification | DriftNotification | DigestNotification;

export interface Email {
  subject: string;
  /** Plain text. Deliverability is better and there is nothing here worth styling. */
  text: string;
}

export function compose(notification: Notification): Email {
  switch (notification.kind) {
    case "run-completed":
      return runCompleted(notification);
    case "run-partial":
      return runPartial(notification);
    case "run-failed":
      return runFailed(notification);
    case "revert-completed":
      return revertCompleted(notification);
    case "drift-hold":
      return driftHold(notification);
    case "weekly-digest":
      return digest(notification);
  }
}

function runCompleted(n: RunNotification): Email {
  return {
    subject: `"${n.campaignName}" finished — ${n.counts.verified} variants updated`,
    text: [
      `"${n.campaignName}" has finished and every row was read back and confirmed.`,
      "",
      ...countLines(n.counts),
      "",
      "Your storefront now shows the campaign price for these products.",
      link(n.campaignUrl),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function runPartial(n: RunNotification): Email {
  return {
    subject: `"${n.campaignName}" finished partially — ${n.counts.failed} rows need attention`,
    text: [
      `"${n.campaignName}" has finished, but not every row landed.`,
      "",
      ...countLines(n.counts),
      "",
      // Named plainly, because the alternative reading of a partial run is that the
      // app does not know what it did. It does, per row.
      "Nothing is hidden: every row that did not complete has a reason recorded against",
      "it, and the prices that did apply are live. Resuming retries only the rows that",
      "are outstanding.",
      ...reasonLines(n.reasons),
      link(n.campaignUrl, "Open the campaign to review and resume"),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function runFailed(n: RunNotification): Email {
  return {
    subject: `"${n.campaignName}" could not run`,
    text: [
      `"${n.campaignName}" stopped before it could finish.`,
      "",
      ...countLines(n.counts),
      ...reasonLines(n.reasons),
      "",
      "Prices already written are unchanged and recorded. Fixing the cause and resuming",
      "picks up exactly where this run stopped.",
      link(n.campaignUrl, "Open the campaign"),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function revertCompleted(n: RunNotification): Email {
  return {
    subject: `"${n.campaignName}" has been reverted`,
    text: [
      `"${n.campaignName}" is over and its prices have been recomputed without it.`,
      "",
      ...countLines(n.counts),
      "",
      // Worth saying every time: this is the single most misunderstood thing the app
      // does, and a merchant expecting a snap-back to full price will otherwise read
      // a correct revert as a bug.
      "Reverting recomputes each price rather than restoring a saved number. Where",
      "another campaign still covers a product, that campaign's price stays in place.",
      link(n.campaignUrl),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function driftHold(n: DriftNotification): Email {
  return {
    subject: `"${n.campaignName}" — ${n.driftedCount} prices changed outside the app`,
    text: [
      `${n.driftedCount} product${n.driftedCount === 1 ? "" : "s"} covered by`,
      `"${n.campaignName}" ${n.driftedCount === 1 ? "has" : "have"} been repriced somewhere other than this app.`,
      "",
      "Those edits were made on purpose by someone, so the app has not overwritten them.",
      "Each one is waiting for a decision: keep the new price as the new normal, put the",
      "campaign price back, or leave it alone this time.",
      link(n.campaignUrl, "Review the drift queue"),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function digest(n: DigestNotification): Email {
  return {
    subject: `${n.shopName}: ${n.campaignsRun} campaign${n.campaignsRun === 1 ? "" : "s"} this week`,
    text: [
      `A week of pricing on ${n.shopName}.`,
      "",
      `Campaigns run: ${n.campaignsRun}`,
      `Variants changed: ${n.variantsChanged}`,
      `Runs finished partially: ${n.partialRuns}`,
      `Drift waiting on a decision: ${n.driftOpen}`,
      "",
      n.partialRuns > 0 || n.driftOpen > 0
        ? "Anything above zero on the last two lines is waiting for you."
        : "Nothing is waiting for you.",
    ].join("\n"),
  };
}

/**
 * The counts, and only the counts.
 *
 * Zeroes are omitted rather than listed. "0 failed, 0 skipped, 0 clamped" is three
 * lines of noise that makes the one number that matters harder to find.
 */
function countLines(counts: RunCounts): string[] {
  const lines = [`Variants updated and verified: ${counts.verified}`];
  if (counts.failed > 0) lines.push(`Failed: ${counts.failed}`);
  if (counts.unverified > 0) lines.push(`Applied but not confirmed: ${counts.unverified}`);
  if (counts.skipped > 0) lines.push(`Skipped: ${counts.skipped}`);
  if (counts.clamped > 0) lines.push(`Adjusted to stay within your guardrails: ${counts.clamped}`);
  return lines;
}

function reasonLines(reasons?: string[]): string[] {
  if (!reasons?.length) return [];
  return ["", "What went wrong:", ...reasons.slice(0, 5).map((reason) => `  - ${reason}`)];
}

function link(url?: string, label = "Open the campaign"): string {
  return url ? `\n${label}: ${url}` : "";
}
