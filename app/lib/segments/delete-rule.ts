/**
 * When a segment can be deleted, and what to do first when it can't (#776).
 *
 * Every campaign that had ever used a segment blocked its deletion, an archived draft
 * included, with "remove from campaigns first" -- which nothing in the app can do. So a
 * merchant running weekly spreadsheet imports gained a permanent segment a week.
 *
 * Only a campaign that is pricing, or about to, needs its segment: it is what the run, the
 * scheduler and a revert's recompute read. A draft, a finished campaign or a cancelled one
 * can lose it -- `scopeOf` then matches nothing and an Apply is refused by name, rather
 * than falling back to a stored filter that may match the whole catalogue.
 */

export interface SegmentUser {
  id: string;
  name: string;
  status: string;
}

/** What has to happen to a campaign in this state before its segment can go, or null. */
export function stepBeforeDeleting(status: string): string | null {
  switch (status) {
    case "SCHEDULED":
      return "unschedule it";
    case "ACTIVE":
    case "HELD":
    case "PARTIAL":
      return "revert it";
    case "APPLYING":
    case "REVERTING":
      return "wait for its run to finish";
    default:
      return null;
  }
}

/** The campaigns that keep a segment from being deleted: the ones pricing, or about to. */
export function campaignsBlockingDelete<User extends SegmentUser>(users: readonly User[]): User[] {
  return users.filter((user) => stepBeforeDeleting(user.status) !== null);
}

/**
 * Why a segment can't be deleted yet and what to do about it, naming each campaign, or
 * null when nothing blocks it. Shown in the segment's row, where Delete would be.
 */
export function deleteBlockedReason(users: readonly SegmentUser[]): string | null {
  const blocking = campaignsBlockingDelete(users);
  if (blocking.length === 0) return null;
  if (blocking.length === 1) {
    const [only] = blocking;
    return `In use by "${only.name}": ${stepBeforeDeleting(only.status)} first, from its page, then delete.`;
  }
  const steps = blocking.map((user) => `"${user.name}" (${stepBeforeDeleting(user.status)})`);
  return `In use by live campaigns: ${steps.join(", ")}. Do that from each campaign's page, then delete.`;
}
