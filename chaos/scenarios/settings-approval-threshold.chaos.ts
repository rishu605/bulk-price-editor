/**
 * The two-person rule can be switched on from Settings, and every change says who made it (#788).
 *
 * The rule shipped with no field to set it, so the only writer was a test, and a store that
 * had it switched on through the database lost it to the next unrelated save. #872 stopped
 * the save clearing it; this is the field, its refusals, and the audit entry naming the old
 * value, the new one and the person.
 *
 * Driven through the page's own action; only `authenticate.admin` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { approvalFor } from "../../app/services/approvals.server";
import { readSettings } from "../../app/services/settings.server";
import { withChaos } from "../harness/scenario";

let signedIn = { shop: "", shopId: "", staff: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: signedIn.shop }, sessionToken: { sub: signedIn.staff }, admin: {} }),
  },
}));

type Answer = { ok: boolean; message: string; problems: string[] };

/**
 * A save by this staff member, posting what the page would: every field it renders, as
 * stored, with these changed and those in `omit` left out.
 */
async function save(staff: string, fields: Record<string, string>, omit: string[] = []): Promise<Answer> {
  const { action } = await import("../../app/routes/app.settings._index");
  signedIn = { ...signedIn, staff };
  const current = await readSettings(signedIn.shopId);
  const body = new FormData();
  const page: Record<string, string> = {
    minMarginPercent: current.minMarginPercent?.toString() ?? "",
    minPrice: current.minPrice?.toString() ?? "",
    violationPolicy: current.violationPolicy,
    missingCostPolicy: current.missingCostPolicy,
    "rounding.default": current.rounding.default,
    approvalThreshold: current.approvalThreshold?.toString() ?? "",
    email: "",
    ...fields,
  };
  for (const [key, value] of Object.entries(page)) if (!omit.includes(key)) body.set(key, value);
  return (await action({
    request: new Request("https://example.invalid/app/settings", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as Answer;
}

/** The threshold's own audit entries, oldest first. */
const thresholdEntries = (shopId: string) =>
  prisma.auditLogEntry.findMany({
    where: { shopId, action: "settings.approval.update" },
    orderBy: { createdAt: "asc" },
    select: { actor: true, before: true, after: true },
  });

describe("chaos: the approval threshold in Settings", () => {
  it("sets it with an audit entry, keeps it through other saves, clears it, and refuses what is not a count", async () => {
    await withChaos("settings-approval-threshold", { catalog: { products: 3, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId } = chaos.fixture;
      signedIn = { shop: domain, shopId, staff: "" };
      expect((await readSettings(shopId)).approvalThreshold, "the fixture starts with approvals off").toBeNull();

      // Set: stored, and one entry naming nothing → 1 and who did it.
      const set = await save("alice", { approvalThreshold: "1" });
      expect(set.ok, set.problems.join(" ")).toBe(true);
      expect((await readSettings(shopId)).approvalThreshold).toBe(1);
      expect(await thresholdEntries(shopId)).toEqual([
        { actor: "staff:alice", before: { approvalThreshold: null }, after: { approvalThreshold: 1 } },
      ]);

      // And the run path's gate now engages: three variants is more than one.
      expect(await approvalFor(shopId, campaignId)).toMatchObject({ required: true, state: "none" });

      // Changed by somebody else: the entry names them, and the value it replaced.
      expect((await save("bob", { approvalThreshold: "2" })).ok).toBe(true);
      expect((await thresholdEntries(shopId)).at(-1)).toEqual({
        actor: "staff:bob",
        before: { approvalThreshold: 1 },
        after: { approvalThreshold: 2 },
      });

      // An unrelated save, as the page posts it -- the field carrying what it shows --
      // and as a post that does not carry the field at all: unchanged, and no new entry.
      expect((await save("alice", { minPrice: "4.99", violationPolicy: "skip" })).ok).toBe(true);
      expect((await save("alice", { minMarginPercent: "10" }, ["approvalThreshold"])).ok).toBe(true);
      const kept = await readSettings(shopId);
      expect(kept.minPrice).toBe(4.99);
      expect(kept.minMarginPercent).toBe(10);
      expect(kept.approvalThreshold, "an unrelated save moved the threshold").toBe(2);
      expect(await thresholdEntries(shopId), "an unrelated save logged a threshold change").toHaveLength(2);

      // Refused, each by the field's name, with nothing written: not the threshold, not
      // the margin typed beside it, not an audit entry of either kind.
      const auditBefore = await prisma.auditLogEntry.count({ where: { shopId } });
      for (const typed of ["0", "-3", "abc", "1.5"]) {
        const refused = await save("alice", { approvalThreshold: typed, minMarginPercent: "30" });
        expect(refused.ok, `${typed} was saved`).toBe(false);
        expect(refused.problems).toEqual([
          `Require a second person's approval above (variants) must be a whole number of 1 or more, or blank for off. “${typed}” is not.`,
        ]);
        const after = await readSettings(shopId);
        expect(after.approvalThreshold, `${typed} changed the threshold`).toBe(2);
        expect(after.minMarginPercent, `${typed}'s save wrote the margin beside it`).toBe(10);
      }
      expect(await prisma.auditLogEntry.count({ where: { shopId } }), "a refused save wrote an audit entry").toBe(
        auditBefore,
      );

      // Cleared: off, with an entry saying from what, and the gate no longer engages.
      expect((await save("bob", { approvalThreshold: "" })).ok).toBe(true);
      expect((await readSettings(shopId)).approvalThreshold).toBeNull();
      expect((await thresholdEntries(shopId)).at(-1)).toEqual({
        actor: "staff:bob",
        before: { approvalThreshold: 2 },
        after: { approvalThreshold: null },
      });
      expect(await approvalFor(shopId, campaignId)).toEqual({ required: false });
    });
  });
});
