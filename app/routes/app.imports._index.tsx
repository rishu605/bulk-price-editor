import { redirect, type LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

/**
 * The imports section has no page of its own yet, so land on the most common source.
 *
 * `?source=` is honoured because that is the shape the old import URLs point at and
 * the shape P7.7's single-route picker will use, so a link written today keeps working
 * once the three sources become one page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const source = new URL(request.url).searchParams.get("source");
  const known = source === "prices" || source === "baselines" || source === "costs";
  return redirect(`/app/imports/${known ? source : "prices"}`);
};
