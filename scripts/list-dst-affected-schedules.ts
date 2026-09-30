#!/usr/bin/env tsx
/**
 * Lists scheduled campaigns whose start or end was stored an hour off by the old
 * conversion (#814, #703). Read-only: it prints, it never writes.
 *
 * The editor used to convert a typed time with the zone offset looked up at the wrong
 * instant, so every time within the zone's UTC offset of a clock change was stored an
 * hour early or late. The typed time is not stored, so this recovers it: it finds the
 * wall-clock time the old conversion would have turned into the stored instant, converts
 * that time correctly, and reports every schedule where the two disagree -- so the
 * merchants concerned can be told, and their campaigns corrected by hand.
 *
 *   npx tsx scripts/list-dst-affected-schedules.ts            # every shop
 *   npx tsx scripts/list-dst-affected-schedules.ts --shop x   # one shop
 */

import prisma from "../app/db.server";
import { shopArg } from "../app/lib/seed/target-shop";
import { parseSchedule, resolveLocalInput, utcToLocalInput } from "../app/lib/scheduling/window";

const DAY = 24 * 60 * 60_000;

/** The zone's offset at an instant, through the app's own formatter. */
function offsetAt(at: number, zone: string): number {
  return Date.parse(`${utcToLocalInput(new Date(at).toISOString(), zone)}:00Z`) - Math.floor(at / 60_000) * 60_000;
}

/** What the pre-#814 conversion produced for a typed wall-clock time. */
function oldConversion(typed: string, zone: string): number {
  const naive = Date.parse(`${typed}:00Z`);
  return naive - offsetAt(naive, zone);
}

/** The typed time that the old conversion turned into `stored`, if there is one. */
function typedFor(stored: number, zone: string): string | null {
  for (const offset of new Set([offsetAt(stored - DAY, zone), offsetAt(stored, zone), offsetAt(stored + DAY, zone)])) {
    const typed = new Date(stored + offset).toISOString().slice(0, 16);
    if (oldConversion(typed, zone) === stored) return typed;
  }
  return null;
}

async function main() {
  const domain = shopArg(process.argv.slice(2));
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: { notIn: ["CANCELLED"] },
      ...(domain ? { shop: { domain } } : {}),
    },
    select: { id: true, name: true, status: true, schedule: true, shop: { select: { domain: true, timezone: true } } },
  });

  let affected = 0;
  for (const campaign of campaigns) {
    const schedule = parseSchedule(campaign.schedule);
    if (schedule.kind !== "window") continue;
    const zone = campaign.shop.timezone;

    for (const [field, iso] of [["start", schedule.startAt], ["end", schedule.endAt]] as const) {
      if (!iso) continue;
      const stored = Date.parse(iso);
      const typed = typedFor(stored, zone);
      if (!typed) continue;
      const correct = resolveLocalInput(typed, zone);
      if (!correct || correct.utc === new Date(stored).toISOString()) continue;

      affected++;
      console.log(
        [
          campaign.shop.domain,
          campaign.id,
          JSON.stringify(campaign.name),
          campaign.status,
          field,
          `typed ${typed} ${zone}`,
          `stored ${new Date(stored).toISOString()} (shows ${utcToLocalInput(new Date(stored).toISOString(), zone)})`,
          `should be ${correct.utc}`,
        ].join("\t"),
      );
    }
  }

  console.log(`\n${affected} schedule time(s) affected across ${campaigns.length} campaign(s) checked.`);
}

main()
  .catch((error) => {
    console.error("\nERROR:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
