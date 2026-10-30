/**
 * A practice campaign's real copy (#1077).
 *
 * A practice campaign's page said "Create a real campaign with the same scope and rule when
 * you are ready" and offered no way to: Apply is refused for practice, the editor refuses its
 * dates (#827), and Duplicate keeps the practice flag on purpose (#762). The merchant had to
 * rebuild the rule and the scope by hand.
 *
 * "Make a real copy" is Duplicate without the flag. Driven through the campaign page's own
 * loader and action, from the practice campaign to its copy's verified apply; only
 * `authenticate.admin` is replaced, with an admin that talks to the fake store.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { isPractice } from "../../app/services/campaigns/model.server";
import { chaosAdminContext } from "../harness/http-client";
import { type ChaosSpec, withChaos } from "../harness/scenario";
import { judge } from "../harness/verdict";
import { redefine } from "../harness/definition";

/** A staff member's id, as App Bridge's session token carries it. */
const STAFF = "91614707946";
let pending = { shop: "", endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: STAFF },
      admin: chaosAdminContext(pending.endpoint),
    }),
  },
}));

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

/** The campaign page's action, as its buttons post to it. A redirect is where it landed. */
async function press(campaignId: string, fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const answer = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body: formOf(fields) }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (answer instanceof Response ? { ok: true, message: "", location: answer.headers.get("Location") } : answer) as {
    ok: boolean;
    message: string;
    location?: string | null;
  };
}

/** The campaign page's loader, as far as this reads it. */
async function page(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as {
    practice: boolean;
    lifecycle: { explanation: string; nextAction?: { intent: string } };
  };
}

/** The copy a press landed on, from its redirect. */
const landedOn = (location: string | null | undefined) => {
  expect(location, "the press did not land on a copy").toMatch(/^\/app\/campaigns\/[^/?]+\?duplicated=1$/);
  return location!.split("/").pop()!.split("?")[0]!;
};

const CATALOG: ChaosSpec = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20, tagKit: ["alpine-sale"] };

describe("chaos: a practice campaign's real copy (#1077)", () => {
  it("is a draft with the same definition, not practice, that applies and verifies, and the practice campaign is left as it was", async () => {
    await withChaos("practice-real-copy", CATALOG, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, baseline, productOf } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };

      // The fixture campaign made practice, as the editor makes one, with what else a copy has
      // to keep: an exclusion -- so a copy that dropped it writes a row too many -- and a note.
      const [excluded, ...priced] = variantGids;
      await redefine(campaignId, { practice: true });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { excludedVariantGids: [excluded!], note: "Try the alpine sale before the season" },
      });
      const source = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });

      // Its page points at the action, and Apply is still refused, naming it.
      const practicePage = await page(campaignId);
      expect(practicePage.practice).toBe(true);
      expect(practicePage.lifecycle.explanation).toMatch(/Make a real copy/);
      const refused = await press(campaignId, { intent: "apply", confirmation: "apply" });
      expect(refused.ok, "a practice campaign was applied").toBe(false);
      expect(refused.message).toMatch(/practice campaign, so it cannot be applied.*Make a real copy/);
      expect(chaos.fake.writeLog).toHaveLength(0);

      // The press.
      const made = await press(campaignId, { intent: "real-copy" });
      const copyId = landedOn(made.location);
      expect(copyId).not.toBe(campaignId);
      const copy = await prisma.campaign.findUniqueOrThrow({ where: { id: copyId } });

      // A draft, real, named for what it is, and with no dates.
      expect(copy.status).toBe("DRAFT");
      expect(isPractice(copy), "the real copy is practice").toBe(false);
      expect(copy.name).toBe(`${source.name} (real)`);
      expect(copy.startAt).toBeNull();
      expect(copy.endAt).toBeNull();
      expect(copy.archivedAt).toBeNull();
      // Run by hand, and nothing of the source's blob, which holds no definition (#1141).
      expect(copy.schedule).toEqual({ kind: "manual" });
      // Everything that decides a price is in its columns (#884), as the source has it, less the flag.
      expect(copy.practice).toBe(false);
      for (const field of [
        "filter",
        "segmentId",
        "rounding",
        "ruleRows",
        "surfaces",
        "compareAtPolicy",
        "compareAtViolationPolicy",
        "guardrails",
        "guardrailViolationPolicy",
        "roundingProfileId",
        "tagKit",
        "autoEnroll",
        "priority",
        "excludedVariantGids",
        "note",
      ] as const) {
        expect(copy[field], `the copy lost its ${field}`).toEqual(source[field]);
      }

      // The practice campaign is left exactly as it was, and its history stays with it.
      expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toEqual(source);
      expect(await prisma.campaignRun.count({ where: { campaignId: copyId } })).toBe(0);
      const copyLog = await prisma.auditLogEntry.findMany({ where: { shopId, entityId: copyId } });
      expect(copyLog.map((entry) => entry.action)).toEqual(["campaign.duplicate"]);
      expect(copyLog[0]!.actor).toBe(`staff:${STAFF}`);
      expect(copyLog[0]!.after).toMatchObject({ from: campaignId, practice: false });

      // Its page offers Apply; pressed, it writes the source's preview and every row reads back.
      const copyPage = await page(copyId);
      expect(copyPage.practice).toBe(false);
      expect(copyPage.lifecycle.nextAction?.intent).toBe("apply");
      const applied = await press(copyId, { intent: "apply", confirmation: "apply" });
      expect(applied.ok, applied.message).toBe(true);
      expect(applied.message).toMatch(/^Applied 2 variants/);

      const run = await prisma.campaignRun.findFirstOrThrow({ where: { campaignId: copyId, kind: "APPLY" } });
      const verdict = await judge({ ...chaos.fixture, campaignId: copyId }, chaos.fake, run.id);
      expect(verdict.violations).toEqual([]);
      expect(verdict.outcome).toBe("clean");
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: copyId } })).status).toBe("ACTIVE");
      for (const gid of priced) {
        expect(chaos.fake.priceOf(gid)).toBe((Math.round(baseline.get(gid)! * 0.8) / 100).toFixed(2));
        expect(chaos.fake.tagsOf(productOf.get(gid)!), "the copy lost its tag kit").toContain("alpine-sale");
      }
      expect(chaos.fake.priceOf(excluded!), "the copy wrote a variant its source excluded").toBe(
        (baseline.get(excluded!)! / 100).toFixed(2),
      );
      const rows = await prisma.variantChange.findMany({ where: { runId: run.id }, select: { variantGid: true, status: true } });
      expect(rows.map((row) => row.variantGid).sort()).toEqual([...priced].sort());
      expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["VERIFIED"]));

      // Duplicate, beside it, still makes another practice campaign (#762).
      const duplicated = await press(campaignId, { intent: "duplicate" });
      const duplicate = await prisma.campaign.findUniqueOrThrow({ where: { id: landedOn(duplicated.location) } });
      expect(isPractice(duplicate), "Duplicate made a real campaign of a practice one").toBe(true);
      expect(duplicate.name).toBe(`${source.name} (copy)`);
    });
  });

  it("is refused for a rule every Apply refuses (#818), naming it, and makes nothing", async () => {
    await withChaos("practice-real-copy-refused", CATALOG, async (chaos) => {
      const { shopId, domain, campaignId } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      await redefine(campaignId, { practice: true });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -150 } }] },
      });
      const before = await prisma.campaign.count({ where: { shopId } });

      const answer = await press(campaignId, { intent: "real-copy" });

      expect(answer.ok, "a real copy of Reduce by 150% was made").toBe(false);
      expect(answer.location).toBeUndefined();
      expect(answer.message).toMatch(/^This campaign reduces prices by 150%.*none was made\./);
      expect(await prisma.campaign.count({ where: { shopId } })).toBe(before);
    });
  });
});
