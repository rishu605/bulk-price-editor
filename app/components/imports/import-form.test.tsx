/**
 * The shared import form posts the check's key back with its commit (#1059).
 *
 * The key was a hidden field on the price import's page alone, so the baseline and cost
 * imports never sent one, and their routes never asked. It is the form's now: a page
 * cannot render an importer without it. Rendered through a static router, because the
 * form's fetcher and its leave guard read the router's state.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, useFetcher } from "react-router";
import { describe, expect, it } from "vitest";

import { ImportForm } from "./ImportForm";

async function render(checkKey: string | undefined): Promise<string> {
  function Page() {
    const fetcher = useFetcher();
    return (
      <ImportForm
        heading="Import baselines from a spreadsheet"
        description={null}
        placeholder="Variant SKU,Price"
        fetcher={fetcher}
        busy={false}
        ready={2}
        checkKey={checkKey}
        commitLabel={(ready) => `Import ${ready} baselines`}
      />
    );
  }
  const handler = createStaticHandler([{ id: "page", path: "/app/prices/baselines", Component: Page }]);
  const context = await handler.query(new Request("https://anchor.example/app/prices/baselines"));
  if (context instanceof Response) throw new Error("the static handler answered with a Response");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToStaticMarkup(<StaticRouterProvider router={router} context={context} hydrate={false} />);
}

/** The form's hidden `checked` field, as markup. */
function checkedField(html: string): string | undefined {
  return html.match(/<input[^>]*name="checked"[^>]*>/)?.[0];
}

describe("the import form's commit", () => {
  it("carries the key the check answered with", async () => {
    const field = checkedField(await render("a".repeat(64)));
    expect(field, "the form posts no key").toBeDefined();
    expect(field).toContain('type="hidden"');
    expect(field).toContain(`value="${"a".repeat(64)}"`);
  });

  it("carries an empty key before a check, or after a commit has spent it", async () => {
    expect(checkedField(await render(undefined))).toContain('value=""');
  });

  it("sits inside the form that posts the rows", async () => {
    const html = await render("k");
    const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
    expect(form).toContain('name="checked"');
    expect(form).toContain('name="csv"');
  });
});
