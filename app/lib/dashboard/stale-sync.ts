/**
 * Whether the catalogue is old enough to say so.
 *
 * `formatAgo` falls back to a date after seven days, and its reasoning is right for the
 * activity feed: "47 days ago" is a subtraction the reader has to undo to place the
 * event against anything else they know.
 *
 * It is not right for **Last synced**, because that fact is not a timestamp — it is a
 * staleness. Every price this app computes comes from the catalogue it captured then, so
 * "28/08/2026" answers *when* while the question underneath is *how out of date is what
 * I am looking at*. The date stays; this adds the sentence that makes it mean something.
 *
 * Only past the week, and only as a caption: a shop that synced this morning does not
 * need to be told its catalogue is current, and a fact that qualifies itself on every
 * render is a fact nobody reads.
 */

const DAY = 86_400_000;
const A_WEEK = 7;

export function staleSync(syncedAt: string | null, now: string): string | undefined {
  if (!syncedAt) return undefined;

  const then = new Date(syncedAt).getTime();
  const at = new Date(now).getTime();
  if (Number.isNaN(then) || Number.isNaN(at)) return undefined;

  const days = Math.floor((at - then) / DAY);
  if (days <= A_WEEK) return undefined;

  return `${days} days ago. Products added or repriced in Shopify since then are not in here yet — re-sync to pick them up.`;
}
