/**
 * What a collector actually receives from a span.
 *
 * Asserted against a real `BasicTracerProvider` and an in-memory exporter rather than
 * against the redactor in isolation, because the bug this covers was not a redactor that
 * got something wrong — it was a redactor that was never called on this path. A test over
 * `redactPricesInText` passed the whole time the price was going out on the wire.
 *
 * Two leaks, and the second had two halves. `span()` passed its attributes straight into
 * `startActiveSpan`, and `recordException` wrote the thrown message onto the span in both
 * `exception.message` and `exception.stacktrace` — so redacting only the message would
 * have cleaned the field somebody reads and left the value beside it.
 */

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { otelEnabledForTests, span } from "./otel.server";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  // Once per process — OTel ignores a second registration, which is itself worth knowing:
  // a per-test provider silently sends every span after the first to the first exporter.
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
  otelEnabledForTests(true);
});

afterAll(() => otelEnabledForTests(false));
beforeEach(() => exporter.reset());

/** The one span the work produced, as the exporter received it. */
async function exported(
  attributes: Record<string, string | number | boolean>,
  work: () => Promise<void> = async () => {},
) {
  await span("write", attributes, work).catch(() => {});
  return exporter.getFinishedSpans()[0];
}

describe("span attributes", () => {
  it("redacts a price the same way a metric label is redacted", async () => {
    const recorded = await exported({ "variant.price": "19.99", "shop.id": "s1" });

    expect(
      recorded.attributes["variant.price"],
      "a span attribute reaches the collector by the same wire as a metric label",
    ).not.toBe("19.99");
    expect(String(recorded.attributes["variant.price"])).not.toMatch(/19\.99/);
  });

  it("redacts by key as well as by shape", async () => {
    const recorded = await exported({ price: 1999, amount: 2500 });

    expect(recorded.attributes.price).not.toBe(1999);
    expect(recorded.attributes.amount).not.toBe(2500);
  });

  /**
   * The other half of the trade. Over-redaction is not free: the ids and cost points on
   * these spans are the whole reason they exist, and a trace that has redacted its own
   * queue name is a trace nobody can use.
   */
  it("leaves the attributes a span exists to carry", async () => {
    const recorded = await exported({
      "queue.name": "execution",
      "shop.id": "s1",
      "campaign.id": "c1",
      "run.id": "r1",
      "graphql.operation": "productVariantsBulkUpdate",
      "shopify.cost.actual": 12,
      "shopify.throttle.available": 987,
      "job.revert": true,
    });

    expect(recorded.attributes).toMatchObject({
      "queue.name": "execution",
      "shop.id": "s1",
      "campaign.id": "c1",
      "run.id": "r1",
      "graphql.operation": "productVariantsBulkUpdate",
      "shopify.cost.actual": 12,
      "shopify.throttle.available": 987,
      "job.revert": true,
    });
  });
});

describe("recorded exceptions", () => {
  /**
   * The realistic path, not a contrived one. Every Admin API call runs inside
   * `span("shopify.graphql", …)`, and `admin-client` throws Shopify's own error text for
   * the mutation that just ran.
   */
  const shopifySaid = "Price must be greater than 19.99 for variant 12345";

  it("scrubs the price out of the exception message", async () => {
    const recorded = await exported({ "shop.id": "s1" }, async () => {
      throw new Error(shopifySaid);
    });

    const event = recorded.events.find((e) => e.name === "exception");
    expect(event, "no exception was recorded, so this proves nothing").toBeDefined();
    expect(String(event!.attributes!["exception.message"])).not.toMatch(/19\.99/);
  });

  it("scrubs the stacktrace too, which repeats the message on its first line", async () => {
    const recorded = await exported({ "shop.id": "s1" }, async () => {
      throw new Error(shopifySaid);
    });

    const event = recorded.events.find((e) => e.name === "exception");
    expect(String(event!.attributes!["exception.stacktrace"] ?? "")).not.toMatch(/19\.99/);
  });

  it("keeps the exception useful — the type, and the part that is not a price", async () => {
    const recorded = await exported({ "shop.id": "s1" }, async () => {
      throw new TypeError(shopifySaid);
    });

    const event = recorded.events.find((e) => e.name === "exception");
    expect(event!.attributes!["exception.type"]).toBe("TypeError");
    expect(String(event!.attributes!["exception.message"])).toMatch(/variant 12345/);
  });

  it("records something thrown that is not an Error at all", async () => {
    const recorded = await exported({ "shop.id": "s1" }, async () => {
      throw "refused at 19.99";
    });

    const event = recorded.events.find((e) => e.name === "exception");
    expect(event, "a non-Error throw recorded nothing").toBeDefined();
    expect(String(event!.attributes!["exception.message"])).not.toMatch(/19\.99/);
  });

  it("still marks the span failed and rethrows", async () => {
    const boom = new Error("plain failure");

    await expect(span("write", { "shop.id": "s1" }, async () => {
      throw boom;
    })).rejects.toThrow("plain failure");

    // 2 is ERROR. A span that scrubbed its exception and forgot to fail would be worse
    // than one that leaked, because the trace would read as healthy.
    expect(exporter.getFinishedSpans()[0].status.code).toBe(2);
  });
});
