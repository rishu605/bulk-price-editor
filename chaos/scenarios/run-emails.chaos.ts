/**
 * The merchant who closed the tab hears about a revert that left prices on sale, and about a
 * run that stopped (#710).
 *
 * Every revert was sent as "revert-completed" -- "has been reverted", under the "when a
 * campaign is reverted" preference -- however many prices it left on sale, so a merchant who
 * asked to hear only about problems heard nothing. And `run-failed` had a template and a
 * preference but no sender: `notify` was reached only on a normal return.
 *
 * `notify` is replaced by a recorder; what each kind is gated by is `wants`, tested beside
 * the templates.
 */

import { describe, expect, it, vi } from "vitest";

import type { Notification } from "../../app/lib/notifications/templates";
import { withChaos } from "../harness/scenario";

const sent: Notification[] = [];

vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async (_shopId: string, notification: Notification) => {
    sent.push(notification);
    return { sent: true };
  },
}));

const runEmails = () => sent.filter((n) => n.kind !== "drift-hold" && n.kind !== "weekly-digest");

describe("chaos: what a run tells the merchant by email", () => {
  it("sends a revert that left prices on sale as a partial run, with its reasons", async () => {
    await withChaos("run-emails-partial-revert", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      await chaos.apply();
      sent.length = 0;

      chaos.arm([{ fault: "server-error", match: (query) => query.includes("productVariantsBulkUpdate"), after: 1 }]);
      const reverted = await chaos.revert();
      chaos.heal();
      expect(reverted.clean).toBe(false);

      const [email] = runEmails();
      expect(email, "nothing was sent").toBeDefined();
      expect(email.kind, "a revert that left prices on sale was sent as 'has been reverted'").toBe("run-partial");
      expect(email.kind === "run-partial" && email.revert).toBe(true);
      expect(email.kind === "run-partial" && email.counts.failed).toBeGreaterThan(0);
      expect(email.kind === "run-partial" && (email.reasons ?? []).length).toBeGreaterThan(0);
    });
  });

  it("sends a clean revert as a revert, and a clean apply as a completion", async () => {
    await withChaos("run-emails-clean", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      sent.length = 0;
      await chaos.apply();
      await chaos.revert();
      expect(runEmails().map((n) => n.kind)).toEqual(["run-completed", "revert-completed"]);
    });
  });

  it("sends a run that stopped by throwing, after it had started", async () => {
    await withChaos("run-emails-failed", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      sent.length = 0;
      // Shopify refuses the bulk upload outright: the run has started, and throws.
      chaos.arm([{ fault: "auth-revoked", match: (query) => query.includes("stagedUploadsCreate") }]);
      const thrown = await chaos.apply({ actor: "chaos", forcePath: "bulk" }).catch((error: unknown) => error);
      chaos.heal();
      expect(thrown).toBeInstanceOf(Error);

      const [email] = runEmails();
      expect(email, "a run that stopped sent nothing").toBeDefined();
      expect(email.kind).toBe("run-failed");
      expect(email.kind === "run-failed" && email.revert).toBe(false);
      expect(email.kind === "run-failed" && email.reasons?.[0]).toMatch(/\S/);
    });
  });
});
