/**
 * The deployment configuration, checked against what the app actually reads.
 *
 * A deploy document rots quietly. Nothing fails when it lists a variable the code stopped
 * using, or omits one that was added — it just sends somebody to production with a gap
 * they find at boot, in the environment where finding things is most expensive.
 *
 * So the checks here are the ones a person cannot make by reading: that every variable the
 * code reads is written down, that the scopes agree in three places, and that the two
 * services differ only where they are supposed to.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const runbook = readFileSync(join(ROOT, "docs/deploying-to-railway.md"), "utf8");

/** Every `process.env.X` the app or its scripts read. */
function environmentKeys(): Set<string> {
  const keys = new Set<string>();

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;

      const source = readFileSync(join(ROOT, path), "utf8");
      for (const [, key] of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(key);
    }
  };

  walk("app");
  walk("scripts");

  return keys;
}

describe("the Railway runbook", () => {
  it("documents every environment variable the app reads", () => {
    // Variables the platform or the image sets, which nobody has to be told about.
    const provided = new Set(["NODE_ENV", "PORT", "SHOP_CUSTOM_DOMAIN"]);

    const undocumented = [...environmentKeys()]
      .filter((key) => !provided.has(key))
      .filter((key) => !runbook.includes(key))
      .sort();

    expect(
      undocumented,
      "read by the code and absent from the runbook — somebody will find this at boot",
    ).toEqual([]);
  });

  it("agrees with the app manifest about scopes", () => {
    // Three places state the scope set and all three are load-bearing: the manifest is
    // what Shopify grants, `SCOPES` is what the app asks the session layer for, and a
    // mismatch shows up as an authorisation failure with no obvious cause.
    const toml = readFileSync(join(ROOT, "shopify.app.toml"), "utf8");
    const declared = /scopes\s*=\s*"([^"]*)"/.exec(toml)?.[1];

    expect(declared).toBeTruthy();
    expect(runbook, "the runbook's SCOPES row disagrees with the manifest").toContain(declared!);

    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(example, ".env.example disagrees with the manifest").toContain(`SCOPES=${declared}`);
  });

  it("points the healthcheck at a route that exists", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "railway.json"), "utf8"));
    const path = config.deploy?.healthcheckPath;

    expect(path).toBe("/healthz");
    // A healthcheck pointed at a missing route fails every deploy, and the failure reads
    // as "the app did not start" rather than "the path is wrong".
    expect(readdirSync(join(ROOT, "app/routes"))).toContain("healthz.tsx");
  });

  it("keeps the worker off the migration path", () => {
    // Only the web service migrates. Two services racing `prisma migrate deploy` is a lock
    // fight at best and a half-applied schema at worst, so the worker's command must not
    // reach it.
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;

    expect(scripts["docker-start"]).toContain("setup");
    expect(scripts.worker).not.toContain("setup");
    expect(scripts.worker).not.toContain("migrate");
  });

  it("ships the worker's runtime dependencies in the production image", () => {
    // The worker starts through `tsx`. As a dev dependency it would build cleanly under
    // `npm ci --omit=dev` and then fail to start — in the deployed environment, which is
    // the worst place to discover a missing package.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const binary = pkg.scripts.worker.split(" ")[0];

    expect(pkg.dependencies).toHaveProperty(binary);
  });
});
