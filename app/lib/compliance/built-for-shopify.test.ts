/**
 * Built for Shopify criteria, checked against the source rather than a checklist.
 *
 * Nine of fourteen direct competitors carry the badge, so it is an entry requirement
 * rather than a nice-to-have — and certification measurably moves App Store search rank.
 *
 * A checklist somebody ticked once is worth very little: the interesting failures are the
 * ones introduced afterwards by a change that looked unrelated. Everything here that can
 * be verified mechanically is, and runs on every CI build. What cannot — colour contrast,
 * keyboard traps, real admin performance — is listed in `docs/built-for-shopify.md` with
 * how it was checked and by whom.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function sourceFiles(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (match.test(entry.name)) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const routes = sourceFiles("app/routes", /\.tsx$/);
const components = sourceFiles("app/components", /\.tsx$/);

/**
 * The embedded admin surface.
 *
 * `_index` is the app's public landing page — it renders outside Shopify's admin, where
 * App Bridge is not loaded and Polaris web components therefore do not exist. The design
 * criteria are about the embedded experience, so holding a plain login page to them would
 * be checking the wrong thing.
 */
const ui = [
  ...routes.filter((file) => !file.includes("routes/_index")),
  ...components,
];

describe("performance — no storefront impact", () => {
  it("ships no theme app extension", () => {
    // The criterion the app satisfies by construction: campaign-scoped tags are the
    // storefront hook, and a theme a merchant's own developer maintains is not something
    // this app should be adding to.
    const extensions = existsSync(join(ROOT, "extensions"))
      ? readdirSync(join(ROOT, "extensions"))
      : [];

    for (const name of extensions) {
      const toml = join(ROOT, "extensions", name, "shopify.extension.toml");
      if (!existsSync(toml)) continue;

      const contents = readFileSync(toml, "utf8");
      expect(contents, `${name} is a theme extension`).not.toMatch(
        /type\s*=\s*"theme(_app_extension)?"/,
      );
    }
  });
});

describe("design — Polaris and App Bridge", () => {
  it("uses no native form outside the App Bridge-safe wrapper", () => {
    // A native form does a full navigation that wipes App Bridge's host, id_token and
    // shop parameters. The server then sees no shop and the merchant gets a blank page —
    // which is both a broken app and a design-criterion failure for full page reloads.
    for (const file of ui) {
      if (file.endsWith("FilterForm.tsx")) continue;
      const source = readFileSync(file, "utf8");

      expect(source, `${file} uses a native <form>`).not.toMatch(/<form[\s>]/);
    }
  });

  it("labels every form field", () => {
    // WCAG AA, and also simply usable. A field whose only description is placeholder
    // text is unreadable to a screen reader and invisible once somebody starts typing.
    const FIELDS = [
      "s-text-field",
      "s-number-field",
      "s-select",
      "s-checkbox",
      "s-text-area",
      "s-date-field",
      "s-money-field",
      "s-email-field",
    ];

    for (const file of ui) {
      const source = readFileSync(file, "utf8");

      for (const field of FIELDS) {
        // Each opening tag with everything up to its closing bracket, so a label on a
        // later line counts — which is how most of them are written.
        const pattern = new RegExp(`<${field}\\b[^>]*>`, "gs");
        for (const match of source.matchAll(pattern)) {
          expect(
            /\blabel=|\baccessibilityLabel=/.test(match[0]),
            `${file}: a <${field}> has no label`,
          ).toBe(true);
        }
      }
    }
  });

  it("never renders a raw HTML input other than a hidden one", () => {
    // Hidden inputs carry intent through a form and have no Polaris equivalent. Anything
    // visible should be a Polaris component, or the app has two visual languages in it.
    for (const file of ui) {
      const source = readFileSync(file, "utf8");

      for (const match of source.matchAll(/<input\b[^>]*>/gs)) {
        expect(
          /type="hidden"/.test(match[0]),
          `${file}: a visible <input> should be a Polaris field`,
        ).toBe(true);
      }
    }
  });
});

describe("integration — API, auth and webhooks", () => {
  it("pins one API version, with no environment override", () => {
    // A worker and a web process on different versions is a class of bug that only ever
    // shows up in production, and only sometimes.
    const source = readFileSync(join(ROOT, "app/lib/shopify/api-version.ts"), "utf8");

    expect(source).toMatch(/export const API_VERSION\s*=\s*ApiVersion\./);
    expect(source, "the API version must not be overridable by env").not.toMatch(
      /process\.env\.\w*API_VERSION/,
    );
  });

  it("authenticates every webhook route", () => {
    // The HMAC check lives inside authenticate.webhook. A route without it accepts
    // anything anyone sends.
    const webhooks = routes.filter((file) => file.includes("/webhooks."));

    expect(webhooks.length).toBeGreaterThan(0);
    for (const file of webhooks) {
      expect(readFileSync(file, "utf8"), `${file} does not authenticate`).toMatch(
        /authenticate\.webhook\(/,
      );
    }
  });

  it("authenticates every embedded route", () => {
    const embedded = routes.filter(
      (file) => /\/app\./.test(file) && !file.includes("webhooks") && !file.endsWith("app.tsx"),
    );

    for (const file of embedded) {
      const source = readFileSync(file, "utf8");
      if (!/export const (loader|action)/.test(source)) continue;

      expect(source, `${file} has a loader or action that does not authenticate`).toMatch(
        /authenticate\.(admin|flow)\(/,
      );
    }
  });

  it("registers all three mandatory GDPR topics", () => {
    const toml = readFileSync(join(ROOT, "shopify.app.toml"), "utf8");

    for (const topic of ["customers/data_request", "customers/redact", "shop/redact"]) {
      expect(toml, `${topic} is not registered`).toContain(topic);
    }
  });

  it("keeps requested scopes to the ones the app demonstrably uses", () => {
    // Every extra scope is a reason a merchant declines the install, and a question at
    // review. Both were established empirically by `npm run scope:probe` — all thirteen
    // mutations in RFC §6 pass under `write_products` alone, and markets needs its own.
    //
    // `read_markets` rather than `write_markets`: nothing in the app writes a market, and
    // the test below keeps that true. The install screen asks to *view* the merchant's
    // markets instead of to *manage* them, which is not a small difference in a sentence
    // somebody reads before handing a pricing app access to their store.
    const toml = readFileSync(join(ROOT, "shopify.app.toml"), "utf8");
    const match = /scopes\s*=\s*"([^"]*)"/.exec(toml);

    expect(match).not.toBeNull();
    const scopes = (match?.[1] ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);

    expect(scopes.sort()).toEqual(["read_markets", "write_products"]);
  });

  it("sends no mutation that would need write access to markets", () => {
    /**
     * The evidence behind asking for `read_markets` rather than `write_markets`.
     *
     * The market surface works entirely through *price lists* — created, adjusted and
     * populated under `write_products` — plus a read of which markets exist. No market
     * itself is ever created, renamed, deleted or reconfigured by this app.
     *
     * That cannot be proven by probing, because a scope that is present is never
     * exercised as absent: with `write_markets` granted, every probe passes whether or not
     * it needs the scope. And narrowing the manifest does not narrow an existing install —
     * the granted set still read `write_markets` after the change, because a smaller ask
     * needs no new consent. So the argument has to be static, and static arguments rot.
     *
     * This is the argument, enforced. Adding a market mutation is a legitimate thing to
     * want; doing it without widening the manifest would be a run that fails on every
     * merchant store, and doing it *with* one is a re-authorisation prompt for every
     * existing install. Either way it should be a decision, not a surprise.
     */
    const roots = ["app/lib", "app/services", "app/routes", "scripts"];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;

        const source = readFileSync(join(ROOT, path), "utf8");
        // A mutation field on the root Mutation type whose name begins with `market`.
        // Deliberately not matching `marketing…` or a `markets` query.
        for (const [match] of source.matchAll(
          /\bmarket(?:Create|Update|Delete|CurrencySettingsUpdate|RegionsDelete|RegionCreate|LocalConditionsUpdate|WebPresence\w*)\s*\(/g,
        )) {
          offenders.push(`${path}: ${match.trim()}`);
        }
      }
    };

    for (const root of roots) walk(root);

    expect(
      offenders,
      "a market mutation needs write_markets, which the manifest no longer asks for",
    ).toEqual([]);
  });
});