/**
 * The release is named from Railway's commit when nothing more specific is set (#1147):
 * production said "App version: dev" because only Heroku's variable was read.
 */

import { describe, expect, it } from "vitest";

import { releaseOf } from "./release";

describe("releaseOf", () => {
  it("reads Railway's deployed commit, which is what production has", () => {
    expect(releaseOf({ RAILWAY_GIT_COMMIT_SHA: "6a7a42dabc" })).toBe("6a7a42dabc");
  });

  it("prefers an explicit release, then the platform's build commit, then Railway's", () => {
    expect(releaseOf({ SENTRY_RELEASE: "1.4.0", SOURCE_VERSION: "aaa", RAILWAY_GIT_COMMIT_SHA: "bbb" })).toBe("1.4.0");
    expect(releaseOf({ SOURCE_VERSION: "aaa", RAILWAY_GIT_COMMIT_SHA: "bbb" })).toBe("aaa");
  });

  it("is undefined locally, and an empty variable is not a release", () => {
    expect(releaseOf({})).toBeUndefined();
    expect(releaseOf({ SENTRY_RELEASE: "", RAILWAY_GIT_COMMIT_SHA: "" })).toBeUndefined();
  });
});
