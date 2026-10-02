/**
 * A form that asks the loader a question navigates (#716).
 *
 * Recapture's scope picker was a `<fetcher.Form method="get">`. A GET fetcher runs the
 * loader into `fetcher.data`, and the page kept rendering `useLoaderData()` -- so picking
 * a segment changed nothing on screen, the scope posted with Recapture stayed the whole
 * catalogue, and "Replace" re-baselined every variant in the store. The same fetcher's
 * `data` also fed the action-result banner, which showed an empty red box for loader data.
 *
 * A GET form belongs to the page: `<Form method="get">` navigates, the URL carries the
 * choice, and everything rendered from the loader describes it.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../lib/testing/source";

describe("forms that ask the loader", () => {
  it("navigate, rather than loading into a fetcher nothing reads", () => {
    const offenders = sourceFiles("app/routes", "app/components").filter((file) =>
      /<[a-zA-Z]+\.Form\b[^>]*\bmethod="get"/.test(sourceOf(file)),
    );

    expect(offenders).toEqual([]);
  });

  it("holds for the recapture page, whose Replace button posts the scope the loader assessed", () => {
    const page = sourceOf("app/routes/app.prices.baselines.recapture.tsx");
    expect(page).toContain('<Form method="get">');
    expect(page).toContain('<input type="hidden" name="segment" value={segmentId} />');
    expect(page).toContain('<input type="hidden" name="scope" value={assessment.scope} />');
  });

  it("will not replace baselines while the Scope field shows a scope nobody has checked (#780)", () => {
    // Between picking a segment and pressing "Check this scope", everything below the
    // field still describes the scope checked before -- so Replace would rewrite those.
    const page = sourceOf("app/routes/app.prices.baselines.recapture.tsx");
    expect(page).toMatch(/<s-select ref=\{scopeField\} name="segment"/);
    // Natively: React 18 never delivers onChange from a Polaris field (#863).
    expect(page).toMatch(/field\.addEventListener\("change", changed\)/);
    expect(page).toMatch(/disabled=\{assessment\.scope === 0 \|\| unchecked \|\| undefined\}/);
    expect(page).toContain("The scope you picked has not been checked yet.");
  });
});
