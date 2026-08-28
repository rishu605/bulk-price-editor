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
 * ## Running this and getting "no changes" while CI disagrees
 *
 * `app/types/admin-<version>.schema.json` is a 7MB download and is gitignored, so it is
 * cached on a developer machine and fetched fresh on every CI run. Codegen reuses the
 * cache without checking it, which means a schema that has moved upstream produces a
 * clean local run and a failing pipeline — with the error pointing at the generated
 * types, which look correct on the machine that generated them.
 *
 * Delete the schema file before regenerating to reproduce what CI does.
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
