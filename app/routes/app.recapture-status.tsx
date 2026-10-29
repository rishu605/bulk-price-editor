/**
 * One recapture's state, for the recapture page following it in the worker (#1105).
 *
 * The page polls this while a recapture runs, so it can say which step it is on and how far
 * that step has got, and reads itself again once when it ends. Its own loader is the wrong
 * thing to ask every few seconds: it plans the whole scope against every running campaign on
 * every load, and a recapture in the worker can last minutes. This is one indexed read.
 *
 * Outside `/app/prices/*`, as `app.sync-status` and `app.campaign-status` are: a status read
 * has no page of its own to sit under.
 */

import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { recaptureStatus } from "../services/recapture-job.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  // Scoped to the session's shop in the query itself, so one store can never read the state
  // of another's recapture by guessing an id.
  return { recapture: await recaptureStatus({ domain: session.shop }, id) };
};
