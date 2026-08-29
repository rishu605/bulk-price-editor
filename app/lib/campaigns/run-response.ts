/**
 * What a merchant is told after pressing Apply, Revert or Resume.
 *
 * Three outcomes come back looking almost identical — clean, zero rows written, no
 * failures — and mean completely different things. Two of them would render as
 * "Applied 0 variants, all verified": a green tick over a campaign that never ran, on the
 * one screen whose entire job is being the record of what happened to a storefront.
 *
 *   **Deferred.** Another worker already owns this occurrence, so this call wrote nothing
 *   and something else is writing right now.
 *
 *   **Refused.** The run was turned down before it started — too large to finish inside
 *   this request, over the blast-radius threshold, blocked by a plan gate. Nothing was
 *   written and nothing is going to be until the merchant does something.
 *
 *   **Clean.** It ran, and every row was read back and confirmed.
 *
 * A refusal is `ok: false` but not critical. Red would send a merchant hunting for a fault
 * in a system that behaved exactly as designed; warning says "not done, and nothing broke".
 *
 * Out of the route because it is the sentence, not the work — and because the route is
 * against its own length limit, which is what stopped this being three more branches in
 * the action.
 */

export interface RunResponse {
  ok: boolean;
  /** Absent means critical when `ok` is false. See the note above. */
  tone?: "warning";
  message: string;
  details: string[];
}

export function runResponse(
  result: {
    clean: boolean;
    verified: number;
    failed: number;
    unverified: number;
    messages: string[];
    deferredTo?: string | null;
    refused?: string | null;
  },
  verb: string,
): RunResponse {
  if (result.deferredTo) {
    return { ok: true, message: result.messages[0] ?? "", details: [] };
  }

  if (result.refused) {
    return { ok: false, tone: "warning", message: result.refused, details: [] };
  }

  return {
    ok: result.clean,
    message: result.clean
      ? `${verb} ${result.verified} variants, all verified.`
      : `${verb} with ${result.failed} failures and ${result.unverified} unverified. ` +
        `Nothing is hidden — resume to retry.`,
    details: result.messages,
  };
}
