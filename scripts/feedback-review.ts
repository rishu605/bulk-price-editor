/**
 * The weekly feedback review.
 *
 * A ritual rather than a feature, which is why it is a script: the thing that keeps a
 * beta programme from turning into a suggestion box is that every item gets a decision
 * every week, and the decision is one of four — next milestone, later, not doing it, or
 * already shipped.
 *
 *   npx tsx scripts/feedback-review.ts                 # what needs triage
 *   npx tsx scripts/feedback-review.ts themes          # what keeps coming up
 *   npx tsx scripts/feedback-review.ts owed            # who has not been told it shipped
 *   npx tsx scripts/feedback-review.ts triage <id> <p5|p6|wont-do|shipped> [theme]
 */

import prisma from "../app/db.server";
import { awaitingNotice, themes, triage, untriaged } from "../app/services/feedback.server";

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "themes") {
    const rows = await themes();
    if (rows.length === 0) {
      console.log("No themes recorded yet. Put one on each item as you triage it.");
    }
    for (const row of rows) {
      console.log(`${String(row.count).padStart(3)}  ${row.theme}`);
    }
    return;
  }

  if (command === "owed") {
    const owed = await awaitingNotice();
    if (owed.length === 0) {
      console.log("Nobody is waiting to hear that their feedback shipped.");
    }
    for (const item of owed) {
      console.log(`${item.shop.domain}  ${item.shippedAt?.toISOString().slice(0, 10)}  ${first(item.message)}`);
    }
    return;
  }

  if (command === "triage") {
    const [id, status, theme] = rest;
    if (!id || !status) {
      console.error("Usage: triage <id> <p5|p6|wont-do|shipped> [theme]");
      process.exit(1);
    }
    await triage(id, status as never, theme);
    console.log(`${id} → ${status}${theme ? ` (${theme})` : ""}`);
    return;
  }

  const items = await untriaged();
  if (items.length === 0) {
    console.log("Nothing waiting. That is the goal, not a reason to skip next week.");
    return;
  }

  console.log(`${items.length} waiting for a decision, oldest first:\n`);
  for (const item of items) {
    console.log(`${item.id}`);
    console.log(`  ${item.shop.domain} · ${item.sentiment} · ${item.planTier ?? "?"} · ${item.variantCount ?? "?"} variants`);
    console.log(`  on ${item.route ?? "unknown screen"} · ${item.createdAt.toISOString().slice(0, 10)}`);
    console.log(`  ${item.message.replace(/\n+/g, " ").slice(0, 200)}`);
    console.log();
  }
}

const first = (message: string) => message.replace(/\n+/g, " ").slice(0, 80);

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
