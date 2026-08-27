/**
 * No script may guess which store it writes to.
 *
 * `chooseShop` was added when the seeder picked the first shop row it found and could
 * have put a hundred thousand products into the wrong catalogue. The rule was written
 * down and applied to two scripts; five others kept guessing, and they are the dangerous
 * ones — `test-lifecycle` and `test-resume` create products, apply campaigns and edit
 * live prices, and two of the five did not even exclude uninstalled shops, so they could
 * have selected a chaos fixture or a store whose tokens are gone.
 *
 * A comment cannot enforce this and a reviewer will not notice the sixth script. So the
 * check is mechanical: any script that reaches for a shop row has to go through the
 * helper that refuses to guess.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPTS = join(process.cwd(), "scripts");

/** Every runnable script — tests and type declarations excluded. */
function scriptFiles(): string[] {
  return readdirSync(SCRIPTS)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"));
}

/** A script "selects a shop" if it reads a `shop` row without naming one. */
const GUESSES = /prisma\.shop\.(findFirst|findFirstOrThrow|findMany)\(/;

describe("every script names the store it writes to", () => {
  const files = scriptFiles();

  it("found the scripts, so the checks below are not vacuous", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("test-lifecycle.ts");
    expect(files).toContain("seed-store.ts");
  });

  it.each(files)("%s", (file) => {
    const source = readFileSync(join(SCRIPTS, file), "utf8");
    if (!GUESSES.test(source)) return;

    // `findMany` is how the helper is *fed* the candidates, which is the correct shape.
    // What must never happen is reaching for a shop row and using it without asking.
    expect(
      source.includes("chooseShop("),
      `${file} selects a shop row without chooseShop, so it will pick one on its own ` +
        `when more than one store is installed`,
    ).toBe(true);
  });
});
