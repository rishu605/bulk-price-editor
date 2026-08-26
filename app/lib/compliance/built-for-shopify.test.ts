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

import { API_VERSION_STRING, supportedUntil } from "../shopify/api-version";

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
 * Two routes are deliberately outside it, and both render where App Bridge is not loaded
 * and Polaris web components therefore do not exist:
 *
 * - `_index`, the app's public landing page.
 * - `help.$`, the help centre. A merchant reaches it from an error message, an email, or
 *   a session that has already expired, so it must render without App Bridge — and its
 *   search box must be a plain GET form for the same reason. Holding either page to
 *   criteria about the embedded experience would be checking the wrong thing.
 *
 * The exclusion is by exact route rather than a pattern, so a new file cannot quietly opt
 * itself out of the design criteria by living next door. The first test below makes the
 * list earn itself.
 */
const OUTSIDE_THE_ADMIN = ["routes/_index", "routes/help.$"];

const ui = [
  ...routes.filter((file) => !OUTSIDE_THE_ADMIN.some((route) => file.includes(route))),
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
  it("only excuses routes that genuinely render outside the admin", () => {
    // The exclusion list is the one way to escape every criterion below, so it has to
    // earn itself. A route inside the embedded admin authenticates as an admin and mounts
    // AppProvider; a route doing either of those has no business on this list.
    for (const route of OUTSIDE_THE_ADMIN) {
      const file = routes.find((candidate) => candidate.includes(route));
      expect(file, `${route} is excluded but does not exist`).toBeDefined();

      const source = readFileSync(file!, "utf8");
      expect(source, `${route} is excluded but authenticates as embedded admin`).not.toMatch(
        /authenticate\.admin/,
      );
      expect(source, `${route} is excluded but mounts AppProvider`).not.toMatch(/AppProvider/);
    }
  });

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

  it("pins an API version Shopify still supports", () => {
    // Versions are supported for twelve months. Built for Shopify requires a supported
    // one, and without this the discovery moment is the API refusing calls one morning
    // with nothing in the repo having changed.
    //
    // This test is meant to fail. When it does, the fix is to bump the pin, regenerate
    // types against the new schema and read the diff — not to move the deadline.
    const deadline = supportedUntil();

    expect(
      deadline.getTime(),
      `API ${API_VERSION_STRING} is unsupported as of ${deadline.toISOString().slice(0, 10)}. ` +
        `Bump the pin in app/lib/shopify/api-version.ts and re-run graphql-codegen.`,
    ).toBeGreaterThan(Date.now());
  });

  it("derives the support deadline from the version, not from a hand-kept date", () => {
    expect(supportedUntil("2025-10").toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(supportedUntil("2026-01").toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(() => supportedUntil("october-2025")).toThrow();
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

/**
 * The submission evidence sheet and the tests that back it, kept in step.
 *
 * `docs/built-for-shopify.md` is what gets handed over at submission. Its value is
 * entirely in each row naming the test that proves it — and a name in a document is
 * exactly the kind of reference that rots silently when somebody renames a test. Then the
 * sheet still reads as complete while proving nothing, which is worse than having no
 * sheet, because it is the version somebody trusts.
 */
describe("the pre-audit sheet names evidence that exists", () => {
  const sheet = readFileSync(join(ROOT, "docs/built-for-shopify.md"), "utf8");
  const suite = readFileSync(join(ROOT, "app/lib/compliance/built-for-shopify.test.ts"), "utf8");

  /** Test names as this file declares them. */
  const declared = new Set(
    [...suite.matchAll(/^\s*it\("([^"]+)"/gm)].map((match) => match[1]),
  );

  /** Test names the sheet cites, written in backticks in the Evidence column. */
  const cited = [...sheet.matchAll(/\|\s*`([^`]+)`\s*\|/g)].map((match) => match[1]);

  it("cites something at all", () => {
    // Without this the two assertions below pass vacuously on an empty table.
    expect(cited.length).toBeGreaterThan(8);
  });

  it("cites only tests that exist", () => {
    for (const name of cited) {
      // A command rather than a test name is fine — those are cited as commands.
      if (name.startsWith("npm ")) continue;

      expect(declared.has(name), `the sheet cites "${name}", which is not a test here`).toBe(true);
    }
  });

  it("cites every test in this file, so nothing is proved but unlisted", () => {
    const exempt = new Set([
      // Meta-tests about the sheet itself; listing them on the sheet would be circular.
      "cites something at all",
      "cites only tests that exist",
      "cites every test in this file, so nothing is proved but unlisted",
      "derives the support deadline from the version, not from a hand-kept date",
      "does not quietly drop the gaps",
    ]);

    for (const name of declared) {
      if (exempt.has(name)) continue;

      expect(cited.includes(name), `"${name}" proves a criterion the sheet does not list`).toBe(
        true,
      );
    }
  });

  it("does not quietly drop the gaps", () => {
    // A checklist that only contains passes is a checklist nobody checked. If the two
    // known design gaps get closed, this test should be updated deliberately — not by
    // deleting the rows.
    expect(sheet).toMatch(/\|\s*gap\s*\|/);
  });
});
