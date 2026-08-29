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
import { contextLines, type SupportContext } from "../lib/support/context";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SupportResult {
  sent: boolean;
  /** Shown to the merchant when nothing was sent, never swallowed. */
  message: string;
}

export async function sendSupportRequest(input: {
  subject: string;
  body: string;
  replyTo: string;
  context: SupportContext;
}): Promise<SupportResult> {
  // eslint-disable-next-line no-undef
  const { RESEND_API_KEY, NOTIFICATION_FROM_EMAIL, SUPPORT_EMAIL } = process.env;

  if (!RESEND_API_KEY || !NOTIFICATION_FROM_EMAIL || !SUPPORT_EMAIL) {
    // Local development and self-hosted installs. Named plainly rather than pretending
    // to have sent: a merchant who is told "we got it" and hears nothing back has been
    // lied to by an app whose whole proposition is that it tells the truth.
    return {
      sent: false,
      message: "Support email is not configured on this install. Nothing was sent.",
    };
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
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: NOTIFICATION_FROM_EMAIL,
        to: [SUPPORT_EMAIL],
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
      return { sent: false, message: "We could not send that just now." };
    }

    logger.info("support request sent", { shop: input.context.shopDomain });
    return { sent: true, message: "Sent. We reply to every message, usually within a day." };
  } catch (error) {
    logger.warn("support request threw", {
      shop: input.context.shopDomain,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, message: "We could not send that just now." };
  }
}
