/**
 * The Activity log's date filter reads days in the store's zone, the one its times are shown
 * in (#721).
 *
 * The range was built from UTC midnights. A New York shop filtering to 25 Sep got 24 Sep
 * 20:00 to 25 Sep 19:59 local: that evening's entries were missing, and the previous
 * evening's appeared under a 25 Sep filter. Entries are pinned at 23:30 local on the
 * boundary days and read back through the same filter the page and its export use.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { activityFiltersFrom } from "../../app/lib/reporting/export-filters";
import { activity } from "../../app/services/activity.server";
import { withChaos } from "../harness/scenario";

const ZONES = [
  // 23:30 on 24, 25 and 26 Sep, local, as UTC instants.
  { timeZone: "America/New_York", at: ["2026-09-25T03:30:00Z", "2026-09-26T03:30:00Z", "2026-09-27T03:30:00Z"] },
  { timeZone: "Asia/Tokyo", at: ["2026-09-24T14:30:00Z", "2026-09-25T14:30:00Z", "2026-09-26T14:30:00Z"] },
];

describe("chaos: filtering the Activity log by day", () => {
  it("returns the entries made on that day in the store's zone, and no others", async () => {
    await withChaos("activity-days", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;

      for (const { timeZone, at } of ZONES) {
        await prisma.auditLogEntry.deleteMany({ where: { shopId } });
        const days = ["24 Sep", "25 Sep", "26 Sep"];
        await prisma.auditLogEntry.createMany({
          data: at.map((instant, i) => ({
            shopId,
            action: "chaos.activity-day",
            entity: "probe",
            entityId: days[i],
            createdAt: new Date(instant),
          })),
        });

        const query = new URLSearchParams({ from: "2026-09-25", to: "2026-09-25" });
        const { entries, total } = await activity(shopId, activityFiltersFrom(query, timeZone));
        expect(
          entries.map((entry) => entry.entityId),
          `filtering to 25 Sep in ${timeZone}`,
        ).toEqual(["25 Sep"]);
        expect(total).toBe(1);
      }
    });
  });
});
