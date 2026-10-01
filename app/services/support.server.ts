/**
 * Sending a merchant's support request.
 *
 * Through the same transport the run notifications use, for the same reason there is one
 * scheduler: one thing that talks to a mail provider and one place to look when it stops.
 *
 * Where this differs from a notification is what happens when it fails. A notification is
 * a report on work that already happened, so it never throws — losing it costs a merchant
 * an email about something they can still go and look at. A support request is the
 * merchant *asking for help*, and silently dropping it is the worst outcome on this page:
 * they would sit waiting for a reply to a message nobody received. So this returns
 * failure, plainly, and the route says so with the address to write to instead.
 */

import { logger } from "../lib/logging/logger";
import { SUPPORT_ADDRESS } from "../lib/support/contact";
import { contextLines, type SupportContext } from "../lib/support/context";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SupportResult {
  sent: boolean;
  /** Shown to the merchant when nothing was sent, never swallowed. */
  message: string;
}

/**
 * Whether this deployment can send a support request at all.
 *
 * Read as `process.env.X`, not destructured: the runbook check in `deploy-config.test.ts`
 * looked only for that shape, and a destructured `SUPPORT_EMAIL` was the one variable it
 * never saw (#758). It now finds the other shapes too; this keeps the obvious one.
 */
export function supportEmailConfigured(): boolean {
  return Boolean(
    // eslint-disable-next-line no-undef
    process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM_EMAIL && process.env.SUPPORT_EMAIL,
  );
}

/**
 * What a merchant is told when nothing was sent: why, in their terms, and the other way
 * to reach us. Their message stays in the form -- the page never clears it on failure --
 * so they can copy it into an email rather than write it twice.
 */
function notSent(why: string): SupportResult {
  return {
    sent: false,
    message: `${why} Nothing was sent. Email ${SUPPORT_ADDRESS} instead — your message is still in the form to copy.`,
  };
}

export async function sendSupportRequest(input: {
  subject: string;
  body: string;
  replyTo: string;
  context: SupportContext;
}): Promise<SupportResult> {
  if (!supportEmailConfigured()) {
    // Named plainly rather than pretending to have sent: a merchant who is told "we got
    // it" and hears nothing back has been lied to by an app whose whole proposition is
    // that it tells the truth. Addressed to the merchant, not to whoever runs the
    // deployment -- "not configured on this install" was a sentence they could do
    // nothing with (#758).
    return notSent("Sending from inside Anchor isn't available right now.");
  }

  const text = [
    input.body.trim(),
    "",
    "—",
    ...contextLines(input.context),
  ].join("\n");

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        // eslint-disable-next-line no-undef
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // eslint-disable-next-line no-undef
        from: process.env.NOTIFICATION_FROM_EMAIL,
        // eslint-disable-next-line no-undef
        to: [process.env.SUPPORT_EMAIL],
        // So a reply goes to the merchant and not into our own sending mailbox.
        reply_to: input.replyTo,
        subject: `${input.subject} — ${input.context.shopDomain}`,
        text,
      }),
    });

    if (!response.ok) {
      // The status, never the body: the body is the merchant's message.
      logger.warn("support request not delivered", {
        shop: input.context.shopDomain,
        status: response.status,
      });
      return notSent("We couldn't send that just now.");
    }

    logger.info("support request sent", { shop: input.context.shopDomain });
    return { sent: true, message: "Sent. We reply to every message, usually within a day." };
  } catch (error) {
    logger.warn("support request threw", {
      shop: input.context.shopDomain,
      error: error instanceof Error ? error.message : String(error),
    });
    return notSent("We couldn't send that just now.");
  }
}
