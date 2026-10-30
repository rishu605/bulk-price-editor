/**
 * Which build is running, by the commit it was built from (#1147).
 *
 * One answer for everything that names the release -- Sentry's `release`, and Contact
 * support's "App version" -- so a support thread and a stack trace can be lined up. Each
 * read `SENTRY_RELEASE ?? SOURCE_VERSION`, and `SOURCE_VERSION` is Heroku's: Railway sets
 * neither, so production's releases were untagged and Contact support told merchants, and
 * App Review, that it was running "dev". Railway's own is `RAILWAY_GIT_COMMIT_SHA`.
 *
 * Undefined where none is set, which is a local run: the caller decides what to say then.
 */
export function releaseOf(env: Record<string, string | undefined> = fromProcess()): string | undefined {
  return env.SENTRY_RELEASE || env.SOURCE_VERSION || env.RAILWAY_GIT_COMMIT_SHA || undefined;
}

/**
 * The three, read as the runbook's own check reads a variable (`deploy-config.test.ts`), so
 * each stays documented in `docs/deploying-to-railway.md`.
 */
function fromProcess(): Record<string, string | undefined> {
  const { SENTRY_RELEASE, SOURCE_VERSION, RAILWAY_GIT_COMMIT_SHA } = process.env;
  return { SENTRY_RELEASE, SOURCE_VERSION, RAILWAY_GIT_COMMIT_SHA };
}
