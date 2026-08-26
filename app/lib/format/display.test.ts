/**
 * Formatting that does not depend on where the code happens to be running.
 *
 * Found by rendering a component: 120,000 came out as "1,20,000" because the machine's
 * locale was en-IN and `toLocaleString()` with no arguments reads the environment. On a
 * server that is whatever the container is set to, and the string is then hydrated in the
 * merchant's browser, so the two can disagree.
 *
 * The date half matters more. A timestamp formatted without a zone is the server's zone,
 * shown as though it were the merchant's — which in a scheduling product means someone
 * mistimes a sale.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatCount, formatDay, formatWhen } from "./display";

describe("counts group the same way everywhere", () => {
  it("groups in thousands, whatever the machine's locale is", () => {
    expect(formatCount(120_000)).toBe("120,000");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });

  it("does not depend on the ambient locale", () => {
    // The actual defect: en-IN groups as 1,20,000. If this ever matches the environment
    // again, a server and a browser can disagree about the same number.
    expect(formatCount(120_000)).not.toBe((120_000).toLocaleString("en-IN"));
  });

  it("leaves small numbers alone", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });
});

describe("times are the shop's, not the server's", () => {
  const iso = "2026-08-27T02:30:00.000Z";

  it("renders a timestamp in the zone it is given", () => {
    const tokyo = formatWhen(iso, "Asia/Tokyo");
    const newYork = formatWhen(iso, "America/New_York");

    expect(tokyo).not.toBe(newYork);
    // 02:30 UTC is the 27th in Tokyo and still the 26th in New York — the exact class of
    // mistake that makes a merchant think a sale reverts on the wrong day.
    expect(tokyo).toContain("27/08/2026");
    expect(newYork).toContain("26/08/2026");
  });

  it("renders a date in the zone it is given", () => {
    expect(formatDay(iso, "Asia/Tokyo")).toBe("27/08/2026");
    expect(formatDay(iso, "America/New_York")).toBe("26/08/2026");
  });

  it("survives a timezone the shop has set to something unusable", () => {
    // A RangeError here would take down a whole page over a display preference.
    expect(() => formatWhen(iso, "Not/AZone")).not.toThrow();
    expect(formatWhen(iso, "Not/AZone")).toBe(iso);
    expect(formatDay(iso, "Not/AZone")).toBe(iso);
  });
});

describe("nothing formats against the ambient environment", () => {
  /** Every source file under app/, so a new one cannot slip past. */
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(full));
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const files = sources(join(process.cwd(), "app")).filter(
    // The module itself is where the locale is allowed to be named, and tests are
    // allowed to write the wrong thing on purpose — neither renders to a merchant.
    (file) => !file.endsWith("app/lib/format/display.ts") && !/\.test\.tsx?$/.test(file),
  );

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("never calls toLocale* without naming a locale", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");

      for (const match of source.matchAll(/\.toLocale[A-Za-z]*\(\s*\)/g)) {
        expect.fail(
          `${file.replace(process.cwd() + "/", "")} calls ${match[0]} — that reads the ` +
            `machine's locale. Use formatCount/formatWhen/formatDay from lib/format/display.`,
        );
      }
    }
  });

  it("never formats a date without a timezone", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");

      // A locale but no `timeZone` still renders in the server's zone.
      for (const match of source.matchAll(/\.toLocale(?:Date|Time)?String\("[^"]*"\s*\)/g)) {
        expect.fail(
          `${file.replace(process.cwd() + "/", "")} calls ${match[0]} with no timeZone — ` +
            `that is the server's zone shown as the merchant's.`,
        );
      }
    }
  });
});
