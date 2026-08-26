import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` as well as `.ts`: components are rendered to static markup here rather than
    // in a DOM, because the Shopify admin embeds this app in a cross-origin iframe that
    // synthetic scrolling cannot reach — so "check it in the browser" stops at one
    // viewport, and the parts below the fold need a test that runs every time.
    // `scripts/` too: those files send real mutations to a real store, which is why they
    // are already in the GraphQL codegen document set. The same argument applies to their
    // logic — a perf harness that reports a pass it never measured is worth a test.
    include: ["app/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
  },
});
