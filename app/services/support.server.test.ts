/**
 * A support request is the merchant asking for help, and losing one silently is the worst
 * thing this page can do.
 *
 * That is the difference from a run notification, which never throws: a notification is a
 * report on work that already happened, and the merchant can still go and look. Somebody
 * who presses Send here and hears nothing is waiting on a reply to a message that does
 * not exist.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import { sendSupportRequest } from "./support.server";
import { supportContext } from "../lib/support/context";

const context = supportContext({
  shopDomain: "boltify-apps.myshopify.com",
  plan: "Growth",
  appVersion: "abc1234",
  path: "/app/campaigns/c1",
  campaignId: "c1",
  errorId: "e-9",
});

const request = { subject: "Held campaign", body: "It will not resume.", replyTo: "me@shop.com", context };

const sentBody = (fetchMock: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("NOTIFICATION_FROM_EMAIL", "anchor@example.com");
  vi.stubEnv("SUPPORT_EMAIL", "support@example.com");
});

describe("sending", () => {
  it("carries the message, the context, and a reply-to that reaches the merchant", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendSupportRequest(request);

    const sent = sentBody(fetchMock);
    expect(result.sent).toBe(true);
    expect(sent.text).toContain("It will not resume.");
    expect(sent.text).toContain("Error id: e-9");
    // Without this a reply lands in our own sending mailbox, which is a support system
    // that answers itself.
    expect(sent.reply_to).toBe("me@shop.com");
    expect(sent.subject).toContain("boltify-apps.myshopify.com");
  });

  it("says so, rather than claiming success, when the install cannot send", async () => {
    // Local development and self-hosted installs. "We got it" from an app that did not
    // is the one failure a merchant cannot recover from by trying again.
    vi.stubEnv("SUPPORT_EMAIL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendSupportRequest(request);

    expect(result.sent).toBe(false);
    expect(result.message).toContain("Nothing was sent");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a provider failure instead of swallowing it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));

    expect((await sendSupportRequest(request)).sent).toBe(false);
  });

  it("reports a thrown request instead of letting it reach the page as a crash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    const result = await sendSupportRequest(request);

    expect(result.sent).toBe(false);
    expect(result.message).toContain("could not send");
  });
});

describe("what leaves the building", () => {
  it("contains no price, whatever the context", async () => {
    // The rule the whole feature is gated on. The merchant's own words are theirs to
    // send — that sentence is the support request — so this checks the part we attach.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await sendSupportRequest({
      ...request,
      body: "the jacket priced at 19.99",
      context: supportContext({
        shopDomain: "boltify-apps.myshopify.com",
        plan: "Growth",
        appVersion: "abc1234",
        path: "/app/prices/live?amount=29.99",
      }),
    });

    const attached = String(sentBody(fetchMock).text).split("—")[1] ?? "";
    expect(attached).not.toMatch(/\d+\.\d{2}/);
    // And the merchant's own sentence survives intact, because answering it is the job.
    expect(sentBody(fetchMock).text).toContain("19.99");
  });
});
