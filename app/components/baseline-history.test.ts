/**
 * Baselines' History opens where the merchant is looking, named for what they clicked (#753).
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

describe("a variant's baseline history", () => {
  const page = sourceOf("app/routes/app.prices.baselines._index.tsx");

  it("opens in a dialog when History is pressed, rather than a card under the table", () => {
    expect(page).toMatch(/<s-modal\s+id=\{HISTORY_MODAL_ID\}\s+heading=\{`Baseline history of \$\{historyTitle/);
    expect(page).toContain("if (variantGid) historyModal.current?.showOverlay?.();");
    expect(page, "the history is a card again").not.toContain("<Card heading={`Baseline history");
  });

  it("forgets the variant when the dialog closes, so the URL says what is on screen", () => {
    expect(page).toMatch(/element\.addEventListener\("hide", closed\)/);
    expect(page).toContain('next.delete("variant")');
  });
});
