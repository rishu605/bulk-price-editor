/**
 * Stripping secrets out of anything on its way to a log.
 *
 * Error context is genuinely useful for debugging, which is exactly why it is
 * dangerous: the object nearest a failed Shopify call is often the one holding the
 * access token. Redaction happens here, once, on the way out -- rather than relying
 * on every call site to remember what is safe to attach.
 *
 * A leaked `shpat_` token is a full-catalogue write credential, and logs get shipped,
 * pasted into issues and read by support. Treat this as a boundary, not a nicety.
 */

const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|cookie|signature/i;

/** Shopify access tokens and API secrets have recognisable prefixes. */
const SECRET_VALUE = /\b(shpat|shpca|shpss|shppa|shhp)_[A-Za-z0-9]+/g;

const REDACTED = "[redacted]";

/**
 * Returns a copy with secrets replaced.
 *
 * Depth-limited and cycle-safe: logging must never be the thing that hangs or blows
 * the stack. Anything too deep is summarised rather than dropped, so the shape of the
 * data is still visible.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return "[function]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      // Long arrays are noise in a log line; the first few plus a count carry the
      // same diagnostic weight.
      const head = value.slice(0, 20).map((item) => redact(item, depth + 1, seen));
      return value.length > 20 ? [...head, `[+${value.length - 20} more]`] : head;
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
    }
    return out;
  }

  return String(value);
}

/**
 * Scrubs a bare string.
 *
 * Exported because messages and stack traces are stored as plain columns, not inside
 * the context object -- and a token in an error message is exactly as dangerous as
 * one in a field. Anything writing free text to a log or a table goes through here.
 */
export function redactText(text: string): string {
  return redactString(text);
}

function redactString(text: string): string {
  return text.replace(SECRET_VALUE, (match) => `${match.split("_")[0]}_${REDACTED}`);
}
