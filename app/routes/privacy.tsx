/**
 * The privacy policy, served from the app itself.
 *
 * The App Store listing requires a privacy policy URL, and a link that 404s fails review
 * on its own. Serving it from this deploy means the policy and the code it describes ship
 * together, which is the same reason `docs/help` is published from here rather than from
 * a domain nobody owns.
 *
 * Unauthenticated on purpose: a reviewer, and a merchant deciding whether to install,
 * both reach it before any session exists. It contains no shop data.
 *
 * Every claim below is checked against the code, because a privacy policy that overstates
 * is worse than none:
 *
 * - "No customer personal data" is `webhooks.compliance.tsx`, which answers two of the
 *   three GDPR topics by saying we hold none.
 * - "Access tokens encrypted at rest" is `lib/crypto/secrets.ts` (AES-GCM, fresh IV per
 *   encryption) wired in through `EncryptedSessionStorage`.
 * - "Telemetry carries no price values" is the convention in CLAUDE.md and `redact.ts`.
 */

export const meta = () => [
  { title: "Privacy policy · Anchor" },
  { name: "robots", content: "index" },
];

const UPDATED = "23 September 2026";

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 20px 96px;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1f2430;
    background: #ffffff;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 34px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }
  h2 { font-size: 20px; margin: 40px 0 10px; letter-spacing: -0.01em; }
  p, li { color: #3c4457; }
  .updated { color: #6b7386; font-size: 14px; margin: 0 0 32px; }
  ul { padding-left: 22px; }
  li { margin: 6px 0; }
  a { color: #1b4571; }
  .note {
    border-left: 3px solid #f2b345;
    background: #fdf7ec;
    padding: 12px 16px;
    border-radius: 0 8px 8px 0;
    margin: 20px 0;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1420; color: #e6eaf2; }
    p, li { color: #b9c2d4; }
    .updated { color: #8792a8; }
    a { color: #8ab4e8; }
    .note { background: #1b1a12; border-left-color: #f2b345; }
  }
`;

export default function Privacy() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Privacy policy · Anchor</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <main>
          <h1>Privacy policy</h1>
          <p className="updated">Anchor, a Shopify app by DartMode Labs. Last updated {UPDATED}.</p>

          <p>
            Anchor schedules and applies price campaigns on a Shopify store. This page
            says exactly what it stores, what it never stores, and what you can ask us to
            do with it.
          </p>

          <div className="note">
            <strong>Anchor holds no customer personal data.</strong> It reads and writes
            product, variant and price information. It does not request, receive or store
            the names, addresses, emails, orders or payment details of the people who shop
            in your store.
          </div>

          <h2>What Anchor stores</h2>
          <ul>
            <li>
              Your shop domain, the plan you are on, and your store timezone and currency
              settings.
            </li>
            <li>
              A mirror of your catalogue: product and variant identifiers, titles, SKUs,
              vendors, tags, and the prices and compare-at prices on each surface you
              target, including market price lists and B2B catalogues.
            </li>
            <li>
              Baselines, which are the reference prices campaigns compute from, and the
              ledger of every price Anchor has written, so a campaign can be reverted
              exactly.
            </li>
            <li>
              Campaign definitions you create: names, rules, schedules, scopes, priorities
              and any note you attach to them.
            </li>
            <li>
              Costs, if you import them, so margin guardrails can be applied.
            </li>
            <li>
              An audit log of actions taken in the app, recording which staff account
              performed each one, for attribution.
            </li>
            <li>
              Error reports, containing a reference code, the route, the failure and
              redacted technical context, so support can answer a question rather than
              guess at it.
            </li>
          </ul>

          <h2>What Anchor never stores</h2>
          <ul>
            <li>Customer names, emails, addresses, phone numbers or any other customer identifier.</li>
            <li>Orders, carts, checkouts or payment information.</li>
            <li>Card numbers or any financial instrument. Anchor never touches payments.</li>
          </ul>

          <h2>How data is protected</h2>
          <ul>
            <li>
              Shopify access tokens are encrypted at rest with AES-256-GCM, using a fresh
              initialisation vector per encryption, and are re-encrypted whenever a token
              is refreshed.
            </li>
            <li>All traffic to and from the app is over HTTPS.</li>
            <li>
              Telemetry and logs carry shop identifiers, plan, counts and durations only.
              They never carry price values, and sensitive fields are redacted before a
              log line is written.
            </li>
            <li>
              Data is stored on Railway, in managed Postgres and Redis instances that are
              not publicly reachable.
            </li>
          </ul>

          <h2>Who data is shared with</h2>
          <p>
            Anchor does not sell your data and does not share it for advertising. It is
            processed by the services the app runs on, and by nobody else:
          </p>
          <ul>
            <li><strong>Shopify</strong>, which is the source of the catalogue and the destination of every price write.</li>
            <li><strong>Railway</strong>, which hosts the application, its database and its queue.</li>
            <li><strong>Sentry</strong>, which receives error reports so failures can be diagnosed. Price values are not included.</li>
            <li><strong>Resend</strong>, which delivers notification and support emails you have asked for.</li>
          </ul>

          <h2>How long data is kept</h2>
          <p>
            Campaign history and the price ledger are retained for as long as the app is
            installed, because they are what makes a revert correct months after a sale
            ended. When you uninstall Anchor, the shop record and its catalogue mirror,
            baselines, ledger, campaigns and audit log are deleted within 48 hours, which
            is the window Shopify allows for a reinstall to recover a store in error.
          </p>

          <h2>Your rights</h2>
          <p>
            Anchor implements Shopify&apos;s three mandatory compliance webhooks. A request
            for customer data or customer redaction is answered truthfully, which is that
            no customer data is held. A shop redaction request deletes everything belonging
            to that shop.
          </p>
          <p>
            You can also ask us directly, at any time, for a copy of what is stored about
            your shop, or for it to be deleted. Deleting it while the app is installed
            means campaigns and revert history are lost, so we will confirm before acting.
          </p>

          <h2>Cookies</h2>
          <p>
            Anchor runs embedded in the Shopify admin and uses only the session cookie
            required to keep you signed in. It sets no advertising or tracking cookies.
          </p>

          <h2>Changes to this policy</h2>
          <p>
            If this policy changes in a way that affects what is collected or who it is
            shared with, the date at the top changes and the change is described in the
            app&apos;s changelog.
          </p>

          <h2>Contact</h2>
          <p>
            Questions about this policy, or a request about your data, go to{" "}
            <a href="mailto:rishu605@gmail.com">rishu605@gmail.com</a>.
          </p>
        </main>
      </body>
    </html>
  );
}
