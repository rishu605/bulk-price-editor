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

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const ROOT = process.cwd();
const runbook = sourceOf(ROOT, "docs/deploying-to-railway.md");

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

      const source = sourceOf(ROOT, path);
      for (const [, key] of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(key);
    }
  };

  walk("app");
  walk("scripts");

  return keys;
}

describe("the worker's Railway config", () => {
  /**
   * Railway applies a repo's config file to every service built from it, and
   * `railway.json` carries `healthcheckPath: "/healthz"`. The worker serves no HTTP, so
   * it inherited a healthcheck it could never answer — build succeeded, deploy succeeded,
   * then `Network > Healthcheck` failed after the timeout and the deployment was marked
   * FAILED. The worker had never once run.
   *
   * Nothing in that error names the healthcheck as the wrong setting for this service
   * rather than a broken app, which is why it is worth a test rather than a paragraph.
   */
  const web = JSON.parse(sourceOf(ROOT, "railway.json"));
  const worker = JSON.parse(sourceOf(ROOT, "railway.worker.json"));

  it("gives the web service a healthcheck", () => {
    expect(web.deploy?.healthcheckPath, "the web service must be health-checked").toBe(
      "/healthz",
    );
  });

  it("gives the worker none, because it serves no HTTP", () => {
    expect(
      worker.deploy?.healthcheckPath,
      "a healthcheck on the worker can never pass, so every deploy fails",
    ).toBeUndefined();
  });

  it("starts the worker as a worker", () => {
    expect(worker.deploy?.startCommand).toBe("npm run worker");
  });

  it("builds both from the same Dockerfile", () => {
    // The pair that must never disagree about a price is exactly this pair: the worker
    // writes what the web process previewed.
    expect(worker.build).toEqual(web.build);
  });

  it("restarts the worker on failure, like the web service", () => {
    expect(worker.deploy?.restartPolicyType).toBe(web.deploy?.restartPolicyType);
  });
});

describe("the webhooks the manifest subscribes to", () => {
  /**
   * A declared topic with no route, or a route no topic reaches.
   *
   * Both fail silently and in opposite directions. Shopify posts a declared `uri` and
   * gets a 404 — deliveries fail, the subscription is eventually disabled, and the first
   * symptom is a mirror that has quietly stopped tracking the store. A route with no
   * subscription is worse in the other direction: the handler is written, reviewed and
   * tested, and simply never runs, while everybody believes the topic is covered.
   *
   * Neither is visible by reading, and `shopify.app.toml` is rewritten by the CLI on
   * every `shopify app dev`, so this is a file that drifts without anybody editing it.
   *
   * The compliance topics route is exempt from the uri-to-filename rule below because
   * Shopify addresses all three of `customers/data_request`, `customers/redact` and
   * `shop/redact` at one uri.
   */
  const manifest = sourceOf(ROOT, "shopify.app.toml");

  const declared = [...manifest.matchAll(/^\s*uri\s*=\s*"([^"]+)"/gm)].map(([, uri]) => uri);

  /** `/webhooks/app/uninstalled` -> `webhooks.app.uninstalled.tsx`, the flat-route form. */
  const routeFileFor = (uri: string) => `${uri.replace(/^\//, "").replace(/\//g, ".")}.tsx`;

  const routeFiles = readdirSync(join(ROOT, "app/routes")).filter(
    (file) => file.startsWith("webhooks.") && file.endsWith(".tsx"),
  );

  it("declares at least one webhook, so the checks below mean something", () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it.each(declared)("%s is served by a route", (uri) => {
    expect(routeFiles).toContain(routeFileFor(uri));
  });

  it("has no webhook route that nothing is subscribed to", () => {
    expect(new Set(routeFiles)).toEqual(new Set(declared.map(routeFileFor)));
  });
});

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
    const toml = sourceOf(ROOT, "shopify.app.toml");
    const declared = /scopes\s*=\s*"([^"]*)"/.exec(toml)?.[1];

    expect(declared).toBeTruthy();
    expect(runbook, "the runbook's SCOPES row disagrees with the manifest").toContain(declared!);

    const example = sourceOf(ROOT, ".env.example");
    expect(example, ".env.example disagrees with the manifest").toContain(`SCOPES=${declared}`);
  });

  it("points the healthcheck at a route that exists", () => {
    const config = JSON.parse(sourceOf(ROOT, "railway.json"));
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
    const scripts = JSON.parse(sourceOf(ROOT, "package.json")).scripts;

    expect(scripts["docker-start"]).toContain("setup");
    expect(scripts.worker).not.toContain("setup");
    expect(scripts.worker).not.toContain("migrate");
  });

  it("generates the Prisma client in the image, not at boot", () => {
    // The worker starts with `tsx scripts/worker.ts` and runs neither `generate` nor
    // `migrate`. With the client generated only by the web service's start command, the
    // worker imported `db.server.ts`, found nothing, and crashed on every deploy with
    // "@prisma/client did not initialize yet" — after a successful build and deploy.
    //
    // `generate` produces code and belongs to the build. `migrate` changes a database and
    // belongs to one service at deploy time. The test below still holds the second rule.
    const dockerfile = sourceOf(ROOT, "Dockerfile");

    expect(
      dockerfile,
      "nothing generates the Prisma client at build time, so the worker starts without one",
    ).toMatch(/RUN\s+npx\s+prisma\s+generate/);

    // Before the build, since the build may import generated types.
    const generateAt = dockerfile.search(/RUN\s+npx\s+prisma\s+generate/);
    const buildAt = dockerfile.search(/RUN\s+npm\s+run\s+build/);
    expect(generateAt, "generate must come before the build").toBeLessThan(buildAt);
  });

  it("ships the worker's runtime dependencies in the production image", () => {
    // The worker starts through `tsx`. As a dev dependency it would build cleanly under
    // `npm ci --omit=dev` and then fail to start — in the deployed environment, which is
    // the worst place to discover a missing package.
    const pkg = JSON.parse(sourceOf(ROOT, "package.json"));
    const binary = pkg.scripts.worker.split(" ")[0];

    expect(pkg.dependencies).toHaveProperty(binary);
  });
});
