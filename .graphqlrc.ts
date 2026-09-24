import fs from "fs";
import { shopifyApiProject, ApiType } from "@shopify/api-codegen-preset";
import type { IGraphQLConfig } from "graphql-config";

import { API_VERSION_STRING } from "./app/lib/shopify/api-version";

/**
 * GraphQL codegen against the pinned Admin API schema.
 *
 * This config came with the scaffold and worked; what was missing was anybody running
 * it. Every query response in the app is typed by a hand-written interface sitting next
 * to the query string, and those interfaces are guesses — they agree with the schema
 * exactly as far as whoever wrote them remembered. A field that returns null, a
 * connection that grew a level, a rename between API versions: all of it typechecks
 * perfectly and fails at runtime, in code that writes prices.
 *
 * The one change is the version. It used to name `ApiVersion.October25` directly, which
 * was fine until a second place disagreed — and one did. It now comes from the same
 * constant the app speaks, so the schema these types are generated from is the schema
 * the requests actually hit.
 *
 * ## The schema is committed, and that is the point
 *
 * `app/types/admin-<version>.schema.json` used to be gitignored: cached on a developer
 * machine, downloaded fresh on every CI run. Codegen reuses the cache without checking
 * it, so the two ran against different schemas. Shopify edits a doc comment — fulfillment
 * wording, a moved validation URL, a deprecation notice on a mutation this app does not
 * call — and the next PR goes red with a diff its author cannot reproduce and did not
 * cause. #591 has the case that made it worth fixing: a red check was assumed to be the
 * npm-audit flake, merged through, and `main` stayed red.
 *
 * So the schema is pinned the same way the API version is, and for the same reason. A
 * schema is not a thing to re-download per run; it is the contract these types and every
 * query are written against together, and the build should only change when somebody
 * decides it does.
 *
 * `npm run graphql-codegen:refresh` is that decision: it deletes the cached schema, pulls
 * the current one and regenerates. The diff it produces is Shopify's changes, reviewed as
 * a change rather than discovered as a failure.
 *
 * What this does **not** weaken: a query that disagrees with the pinned schema still
 * fails the build. Codegen validates every document and exits non-zero — *"Cannot query
 * field X on type Y"* — writing no output. That check got stronger, not weaker, because
 * it now runs against a schema that cannot shift underneath it.
 */
function getConfig() {
  const config: IGraphQLConfig = {
    projects: {
      default: shopifyApiProject({
        apiType: ApiType.Admin,
        apiVersion: API_VERSION_STRING,
        // `scripts/` is in here because those files send real mutations to a real store
        // — seeding a perf catalogue, probing scopes, spot-checking reconciliation. A
        // typo in one of them fails after the round trip, against somebody's data,
        // rather than at build time. There is no reason the app's queries get checked
        // against the pinned schema and the ones that write to production do not.
        documents: [
          "./app/**/*.{js,ts,jsx,tsx}",
          "./app/.server/**/*.{js,ts,jsx,tsx}",
          "./scripts/**/*.{js,ts}",
        ],
        outputDir: "./app/types",
      }),
    },
  };

  let extensions: string[] = [];
  try {
    extensions = fs.readdirSync("./extensions");
  } catch {
    // ignore if no extensions
  }

  for (const entry of extensions) {
    const extensionPath = `./extensions/${entry}`;
    const schema = `${extensionPath}/schema.graphql`;
    if (!fs.existsSync(schema)) {
      continue;
    }
    config.projects[entry] = {
      schema,
      documents: [`${extensionPath}/**/*.graphql`],
    };
  }

  return config;
}

const config = getConfig();

export default config;
