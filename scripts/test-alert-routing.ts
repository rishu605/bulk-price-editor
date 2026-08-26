/**
 * Fires one alert on purpose, to prove the routing works.
 *
 * An alerting path is only known to work when somebody has watched it deliver. This makes
 * that check one command rather than a production incident.
 *
 *   npx tsx scripts/test-alert-routing.ts            # synthetic firing
 *   npx tsx scripts/test-alert-routing.ts evaluate   # what would fire right now
 */

import prisma from "../app/db.server";
import { checkAlerts, fireSyntheticAlert, gather } from "../app/services/alerting.server";

async function main() {
  if (process.argv[2] === "evaluate") {
    const window = await gather();
    console.log("signals:", JSON.stringify(window, null, 2));

    const result = await checkAlerts();
    if (result.fired.length === 0) {
      console.log("nothing firing.");
    }
    for (const alert of result.fired) {
      console.log(`\n[${alert.severity}] ${alert.title}\n  ${alert.because}\n  ${alert.runbook}`);
    }
    console.log(`\nsent ${result.sent}, suppressed ${result.suppressed}`);
    return;
  }

  const to = process.env.OPERATOR_ALERT_EMAIL;
  console.log(
    to
      ? `Firing a synthetic alert to ${to}.`
      : "No OPERATOR_ALERT_EMAIL set — the alert will be logged and not emailed.",
  );

  await fireSyntheticAlert();
  console.log("Done. Check the log, and the inbox if one is configured.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
