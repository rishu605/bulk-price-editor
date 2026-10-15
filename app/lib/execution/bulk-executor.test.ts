import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import type { PlannedRow, SurfaceRef } from "../planning/types";
import {
  buildMutationLines,
  collect,
  fromString,
  layoutOf,
  parseResults,
  serializeJsonl,
  streamLines,
  type VariantOutcome,
} from "./jsonl";
import {
  isTerminal,
  pollUntilTerminal,
  reconcileResults,
  submitBulkMutation,
  BulkSubmissionError,
  type BulkOperationState,
  type StagedTarget,
} from "./bulk-executor";
import type { AdminClient } from "./sync-executor";
import { toAppError } from "../errors/app-error";

const usd = (n: number) => money(n, "USD");
const noSleep = async () => {};

const ref = (variantGid: string): SurfaceRef => ({
  variantGid,
  surfaceKind: "base",
  priceListGid: "",
  currency: "USD",
});

function row(over: Partial<PlannedRow> = {}): PlannedRow {
  return {
    ref: ref("gid://shopify/ProductVariant/1"),
    intendedPrice: usd(8_000),
    intendedCompareAtSet: false,
    status: "pending",
    ...over,
  };
}

const productOf = (gid: string) =>
  gid.endsWith("/3") ? "gid://shopify/Product/B" : "gid://shopify/Product/A";

/** `count` rows of one product, variant ids 1000, 1001, ... in order. */
function variantsOfOneProduct(count: number, from = 1_000): PlannedRow[] {
  return Array.from({ length: count }, (_, i) => row({ ref: ref(`gid://shopify/ProductVariant/${from + i}`) }));
}
const variantGid = (n: number) => `gid://shopify/ProductVariant/${n}`;

/**
 * Shopify's answer to an upload, as a result file: one line per upload line, under its
 * `__lineNumber`. A line over 250 variants is refused whole, as the mutation refuses it
 * when called directly; `refuse` refuses others the same way; `failing` puts a userError
 * on the variants at those indexes of a line and leaves them out of `productVariants`.
 */
function shopifyAnswers(
  lines: Array<{ variants: Array<Record<string, unknown>> }>,
  options: { refuse?: number[]; failing?: Map<number, number[]> } = {},
): string {
  return lines
    .map((line, lineNumber) => {
      if (line.variants.length > 250 || options.refuse?.includes(lineNumber)) {
        return JSON.stringify({
          __lineNumber: lineNumber,
          errors: [{ message: `The input array size of ${line.variants.length} is greater than the maximum allowed of 250.` }],
        });
      }
      const failing = new Set(options.failing?.get(lineNumber) ?? []);
      return JSON.stringify({
        __lineNumber: lineNumber,
        data: {
          productVariantsBulkUpdate: {
            product: { updatedAt: "2026-10-15T10:00:00Z" },
            productVariants: line.variants
              .filter((_, index) => !failing.has(index))
              .map((v) => ({ id: v.id, price: v.price, compareAtPrice: null })),
            userErrors: [...failing].map((index) => ({
              field: ["variants", String(index), "price"],
              message: "Price is invalid",
              code: "INVALID",
            })),
          },
        },
      });
    })
    .join("\n");
}

describe("JSONL builder", () => {
  it("emits one line per product, not per variant", () => {
    const lines = [
      ...buildMutationLines(
        [
          row({ ref: ref("gid://shopify/ProductVariant/1") }),
          row({ ref: ref("gid://shopify/ProductVariant/2") }),
          row({ ref: ref("gid://shopify/ProductVariant/3") }),
        ],
        productOf,
      ),
    ];
    expect(lines).toHaveLength(2);
    expect(lines[0].variants).toHaveLength(2);
    expect(lines[1].variants).toHaveLength(1);
  });

  it("omits skipped rows and rows with no price", () => {
    const lines = [
      ...buildMutationLines(
        [
          row({ status: "skipped", intendedPrice: undefined }),
          row({ ref: ref("gid://shopify/ProductVariant/2") }),
        ],
        productOf,
      ),
    ];
    expect(lines).toHaveLength(1);
    expect(lines[0].variants).toHaveLength(1);
  });

  it("serialises as newline-delimited JSON", () => {
    const text = [...serializeJsonl(buildMutationLines([row()], productOf))].join("");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text.trim())).toMatchObject({
      productId: "gid://shopify/Product/A",
      variants: [{ id: "gid://shopify/ProductVariant/1", price: "80.00" }],
    });
  });

  it("is a generator, so a large payload is never materialised at once", () => {
    const gen = buildMutationLines([row()], productOf);
    expect(typeof gen[Symbol.iterator]).toBe("function");
    expect(typeof (gen as { next?: unknown }).next).toBe("function");
  });

  it("splits a product with more than 250 variants in scope across lines of at most 250 (#985)", () => {
    // 600 of product A, then 2 of product B. One line per product sent A's 600 as one
    // array, which `productVariantsBulkUpdate` refuses whole.
    const rows = [...variantsOfOneProduct(600), ...variantsOfOneProduct(2, 2_000)];
    const productFor = (gid: string) =>
      Number(gid.split("/").pop()) < 2_000 ? "gid://shopify/Product/A" : "gid://shopify/Product/B";
    const lines = [...buildMutationLines(rows, productFor)];

    expect(lines.map((line) => line.variants.length)).toEqual([250, 250, 100, 2]);
    expect(lines.map((line) => line.productId)).toEqual([
      "gid://shopify/Product/A",
      "gid://shopify/Product/A",
      "gid://shopify/Product/A",
      "gid://shopify/Product/B",
    ]);
    // Every variant exactly once, in the order it was planned.
    const sent = lines.flatMap((line) => line.variants.map((v) => v.id));
    expect(sent).toEqual(rows.map((r) => r.ref.variantGid));
  });

  it("keeps a product of exactly 250 on one line, and puts the 251st on a second", () => {
    expect([...buildMutationLines(variantsOfOneProduct(250), productOf)].map((l) => l.variants.length)).toEqual([250]);
    expect([...buildMutationLines(variantsOfOneProduct(251), productOf)].map((l) => l.variants.length)).toEqual([250, 1]);
  });

  it("lays out each line's variant ids in the order the line sends them", () => {
    const lines = [...buildMutationLines(variantsOfOneProduct(300), productOf)];
    const layout = layoutOf(lines);
    expect(layout.map((line) => line.length)).toEqual([250, 50]);
    expect(layout[1][3]).toBe(variantGid(1_253));
  });
});

describe("a product over the cap, end to end through the result file (#985)", () => {
  // Built, answered as Shopify answers it, and read back -- so a builder that put the
  // product back on one line is caught by its results as well as by its line sizes.
  it("writes all 600 variants of one product, every one reported verified", async () => {
    const rows = variantsOfOneProduct(600);
    const lines = [...buildMutationLines(rows, () => "gid://shopify/Product/A")];

    const out = await reconcileResults(
      { id: "1", status: "COMPLETED", url: "https://r" },
      rows.map((r) => r.ref.variantGid),
      () => fromString(shopifyAnswers(lines)),
      layoutOf(lines),
    );

    expect(out.unreported).toEqual([]);
    expect([...out.outcomes.values()].filter((o) => !o.ok)).toEqual([]);
    expect(out.outcomes.size).toBe(600);
  });

  it("fails a refused line's variants, and only those", async () => {
    const rows = variantsOfOneProduct(600);
    const lines = [...buildMutationLines(rows, () => "gid://shopify/Product/A")];

    const out = await reconcileResults(
      { id: "1", status: "COMPLETED", url: "https://r" },
      rows.map((r) => r.ref.variantGid),
      () => fromString(shopifyAnswers(lines, { refuse: [1] })),
      layoutOf(lines),
    );

    const failed = [...out.outcomes.values()].filter((o) => !o.ok).map((o) => o.variantGid);
    expect(failed).toEqual(Array.from({ length: 250 }, (_, i) => variantGid(1_250 + i)));
    expect(out.outcomes.get(variantGid(1_250))?.failureReason).toMatch(/Line-level error/);
    expect(out.outcomes.get(variantGid(1_249))?.ok).toBe(true);
    expect(out.outcomes.get(variantGid(1_500))?.ok).toBe(true);
    expect(out.unreported).toEqual([]);
  });
});

describe("line streaming", () => {
  it("splits across arbitrary chunk boundaries", async () => {
    async function* chunks() {
      yield '{"a":1}\n{"b"';
      yield ':2}\n{"c":3}';
    }
    expect(await collect(streamLines(chunks()))).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("handles a final line with no trailing newline, and CRLF", async () => {
    expect(await collect(streamLines(fromString('{"a":1}\r\n{"b":2}')))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it("skips blank lines", async () => {
    expect(await collect(streamLines(fromString('{"a":1}\n\n\n{"b":2}\n')))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });
});

describe("result parsing", () => {
  const okLine = (id: string, price: string) =>
    JSON.stringify({
      data: {
        productVariantsBulkUpdate: {
          productVariants: [{ id, price, compareAtPrice: null }],
          userErrors: [],
        },
      },
      __lineNumber: 0,
    });

  it("yields a successful outcome per variant", async () => {
    const out = await collect(parseResults(streamLines(fromString(okLine("gid://v/1", "80.00")))));
    expect(out).toEqual([
      { variantGid: "gid://v/1", ok: true, price: "80.00", compareAtPrice: null, failureReason: undefined },
    ]);
  });

  it("carries the product's updatedAt, Shopify's own timestamp for the write (#932)", async () => {
    const line = JSON.stringify({
      data: {
        productVariantsBulkUpdate: {
          product: { updatedAt: "2026-10-13T23:32:32Z" },
          productVariants: [{ id: "gid://v/1", price: "80.00", compareAtPrice: null }],
          userErrors: [],
        },
      },
      __lineNumber: 0,
    });
    const out = (await collect(parseResults(streamLines(fromString(line))))) as Array<{ remoteUpdatedAt?: string }>;
    expect(out[0].remoteUpdatedAt).toBe("2026-10-13T23:32:32Z");
  });

  it("attributes a positional userError to the right variant", async () => {
    const line = JSON.stringify({
      data: {
        productVariantsBulkUpdate: {
          productVariants: [
            { id: "gid://v/1", price: "80.00" },
            { id: "gid://v/2", price: "70.00" },
          ],
          userErrors: [{ field: ["variants", "1", "price"], message: "Bad price", code: "INVALID" }],
        },
      },
    });
    const out = (await collect(parseResults(streamLines(fromString(line))))) as Array<{
      variantGid: string;
      ok: boolean;
      failureReason?: string;
    }>;
    expect(out[0]).toMatchObject({ variantGid: "gid://v/1", ok: true });
    expect(out[1]).toMatchObject({ variantGid: "gid://v/2", ok: false });
    expect(out[1].failureReason).toContain("Bad price");
  });

  it("reports a malformed line without discarding the rest of the run", async () => {
    // One unparseable line must not throw away 150K rows of results.
    const text = `${okLine("gid://v/1", "80.00")}\nnot json\n${okLine("gid://v/2", "70.00")}\n`;
    const out = await collect(parseResults(streamLines(fromString(text))));
    expect(out).toHaveLength(3);
    expect(out.filter((o) => "malformed" in o)).toHaveLength(1);
    expect(out.filter((o) => "variantGid" in o)).toHaveLength(2);
  });

  it("reports a line-level error", async () => {
    const text = JSON.stringify({ errors: [{ message: "Internal error" }] });
    const out = await collect(parseResults(streamLines(fromString(text))));
    expect(out[0]).toMatchObject({ reason: expect.stringContaining("Internal error") });
  });
});

describe("result parsing against the upload's layout (#985)", () => {
  // One product, 600 variants: lines of 250, 250 and 100. Variant 1000 + n is the
  // product's n-th, so line 1's index 3 is variant 1253 -- not 1003, and not 1254.
  const rows = variantsOfOneProduct(600);
  const lines = [...buildMutationLines(rows, () => "gid://shopify/Product/A")];
  const layout = layoutOf(lines);

  async function outcomes(text: string): Promise<Map<string, VariantOutcome>> {
    const out = await collect(parseResults(streamLines(fromString(text)), layout));
    return new Map(out.filter((o): o is VariantOutcome => "variantGid" in o).map((o) => [o.variantGid, o]));
  }

  it("puts a userError on line N on line N's variant at that index", async () => {
    const out = await outcomes(shopifyAnswers(lines, { failing: new Map([[1, [3]]]) }));

    expect(out.get(variantGid(1_253))).toMatchObject({ ok: false, failureReason: "INVALID: Price is invalid" });
    // Its neighbour, which Shopify reported at index 3 of `productVariants` once 1253 was
    // left out, landed -- and the product's own 4th variant was never in question.
    expect(out.get(variantGid(1_254))?.ok).toBe(true);
    expect(out.get(variantGid(1_003))?.ok).toBe(true);
    expect([...out.values()].filter((o) => !o.ok).map((o) => o.variantGid)).toEqual([variantGid(1_253)]);
    expect(out.size).toBe(600);
  });

  it("names the failed variant when Shopify reports no variants for its line at all", async () => {
    // `productVariantsBulkUpdate` is all-or-nothing unless asked otherwise, so a line with a
    // userError may come back with no variants. The error still names its own variant;
    // the rest of that line are unreported -- unverified, not assumed either way.
    const text = shopifyAnswers(lines)
      .split("\n")
      .map((line, n) =>
        n === 1
          ? JSON.stringify({
              __lineNumber: 1,
              data: {
                productVariantsBulkUpdate: {
                  product: null,
                  productVariants: null,
                  userErrors: [{ field: ["variants", "3", "price"], message: "Price is invalid", code: "INVALID" }],
                },
              },
            })
          : line,
      )
      .join("\n");

    const out = await reconcileResults(
      { id: "1", status: "COMPLETED", url: "https://r" },
      rows.map((r) => r.ref.variantGid),
      () => fromString(text),
      layout,
    );

    expect(out.outcomes.get(variantGid(1_253))).toMatchObject({ ok: false, failureReason: "INVALID: Price is invalid" });
    expect(out.unreported).toHaveLength(249);
    expect(out.unreported).not.toContain(variantGid(1_253));
    expect(out.unreported.every((gid) => layout[1].includes(gid))).toBe(true);
  });

  it("fails every variant of a line refused whole, and no other line's", async () => {
    const out = await outcomes(shopifyAnswers(lines, { refuse: [2] }));

    const failed = [...out.values()].filter((o) => !o.ok).map((o) => o.variantGid);
    expect(failed).toEqual([...layout[2]]);
    expect(out.get(variantGid(1_599))?.failureReason).toMatch(/greater than the maximum allowed/);
  });

  it("takes an index the line does not have as an error for the whole line", async () => {
    const text = shopifyAnswers(lines)
      .split("\n")
      .map((line, n) => {
        if (n !== 2) return line;
        const parsed = JSON.parse(line);
        parsed.data.productVariantsBulkUpdate.userErrors = [{ field: ["variants", "100", "price"], message: "Out of range" }];
        return JSON.stringify(parsed);
      })
      .join("\n");

    const out = await outcomes(text);
    const failed = [...out.values()].filter((o) => !o.ok).map((o) => o.variantGid);
    expect(failed).toEqual([...layout[2]]);
  });

  it("matches by line number, whatever order the result file is in", async () => {
    const shuffled = shopifyAnswers(lines, { failing: new Map([[0, [7]]]) }).split("\n").reverse().join("\n");
    const out = await outcomes(shuffled);
    expect([...out.values()].filter((o) => !o.ok).map((o) => o.variantGid)).toEqual([variantGid(1_007)]);
    expect(out.size).toBe(600);
  });

  it("does not trust a layout the result line disagrees with", async () => {
    // Line 0's answer filed under line 1: it reports variants line 1 never sent. Read
    // against the layout, its userError would land on 1253; read against what it reports,
    // it lands on the variant the line itself names.
    const misfiled = shopifyAnswers([lines[0]], { failing: new Map([[0, [3]]]) }).replace('"__lineNumber":0', '"__lineNumber":1');
    const out = await outcomes(misfiled);

    expect(out.has(variantGid(1_253))).toBe(false);
    expect([...out.keys()].every((gid) => layout[0].includes(gid))).toBe(true);
  });
});

// ------------------------------------------------------------------ submission

function stagedTarget(): StagedTarget {
  return {
    url: "https://staged.example/upload",
    resourceUrl: null,
    parameters: [
      { name: "key", value: "tmp/anchor-bulk.jsonl" },
      { name: "policy", value: "abc" },
    ],
  };
}

interface FakeSubmitOptions {
  stagedErrors?: Array<{ message: string }>;
  submitErrors?: Array<{ message: string }>;
  noTarget?: boolean;
  noKey?: boolean;
}

function submitClient(options: FakeSubmitOptions = {}) {
  const uploaded: string[] = [];
  const client: AdminClient = {
    async request<T>(query: string) {
      if (query.includes("stagedUploadsCreate")) {
        const target = options.noKey
          ? { ...stagedTarget(), parameters: [{ name: "policy", value: "abc" }] }
          : stagedTarget();
        return {
          data: {
            stagedUploadsCreate: {
              stagedTargets: options.noTarget ? [] : [target],
              userErrors: options.stagedErrors ?? [],
            },
          } as T,
        };
      }
      return {
        data: {
          bulkOperationRunMutation: {
            bulkOperation: { id: "gid://bulk/1", status: "CREATED" },
            userErrors: options.submitErrors ?? [],
          },
        } as T,
      };
    },
  };
  const upload = async (_t: StagedTarget, body: string) => {
    uploaded.push(body);
  };
  return { client, upload, uploaded };
}

describe("submission", () => {
  it("uploads the payload and submits the operation", async () => {
    const { client, upload, uploaded } = submitClient();
    const { operation: op, layout } = await submitBulkMutation([row()], { client, upload, productOf, sleep: noSleep });
    expect(op.id).toBe("gid://bulk/1");
    expect(uploaded).toHaveLength(1);
    expect(JSON.parse(uploaded[0].trim())).toMatchObject({ productId: "gid://shopify/Product/A" });
    expect(layout).toEqual([["gid://shopify/ProductVariant/1"]]);
  });

  it("returns the layout of the lines it uploaded, line for line (#985)", async () => {
    // The results are read against this, so it has to be what was sent -- not a second
    // build that happens to agree with it.
    const { client, upload, uploaded } = submitClient();
    const { layout } = await submitBulkMutation(variantsOfOneProduct(600), {
      client,
      upload,
      productOf: () => "gid://shopify/Product/A",
      sleep: noSleep,
    });

    const sent = uploaded[0]
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { variants: Array<{ id: string }> }).variants.map((v) => v.id));
    expect(layout).toEqual(sent);
    expect(layout.map((line) => line.length)).toEqual([250, 250, 100]);
  });

  it("refuses to submit an empty payload, and not as a Shopify rejection", async () => {
    // It used to throw `BulkSubmissionError`, which now means "Shopify refused this".
    // Shopify has refused nothing here — nothing was sent. `selectWritePath(0)` returns
    // the sync path, so an empty run never chooses bulk, and arriving here means a
    // caller forced it. That is our bug, and it must not be dressed up as Shopify's.
    const { client, upload } = submitClient();
    const submitting = submitBulkMutation(
      [row({ status: "skipped", intendedPrice: undefined })],
      { client, upload, productOf, sleep: noSleep },
    );

    await expect(submitting).rejects.toThrow(/no writable rows/);
    await expect(submitting).rejects.not.toBeInstanceOf(BulkSubmissionError);
  });

  it("surfaces userErrors from staging and from submission", async () => {
    const staged = submitClient({ stagedErrors: [{ message: "quota exceeded" }] });
    await expect(
      submitBulkMutation([row()], { ...staged, productOf, sleep: noSleep }),
    ).rejects.toThrow(/quota exceeded/);

    const submit = submitClient({ submitErrors: [{ message: "already running" }] });
    await expect(
      submitBulkMutation([row()], { ...submit, productOf, sleep: noSleep }),
    ).rejects.toThrow(/already running/);
  });

  it("fails clearly when the staged target has no key", async () => {
    // "Clearly" now means two different things for two different readers, which is the
    // point of #649. The merchant is told what happened to their prices and what to do;
    // `key` is a word from Shopify's upload protocol and means nothing to them. The
    // technical detail is kept for whoever reads the log.
    const { client, upload } = submitClient({ noKey: true });

    const error = await submitBulkMutation([row()], {
      client,
      upload,
      productOf,
      sleep: noSleep,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BulkSubmissionError);
    expect((error as BulkSubmissionError).context.detail).toMatch(/key/);
    expect((error as BulkSubmissionError).userMessage).toMatch(/No prices were changed/);
  });

  /**
   * The defect #649 was filed for: the truth was in hand and thrown away one layer later.
   *
   * These rejections carry Shopify's own sentence. Before this, nothing caught them,
   * `classify()` had no branch that matched their wording — it looks for the literal
   * `usererrors`, which `bulkOperationRunMutation failed: …` does not contain — and the
   * merchant was shown "Something went wrong on our side" instead.
   */
  it("reaches the merchant as a Shopify rejection, carrying Shopify's own reason", async () => {
    const cases: Array<{ name: string; options: FakeSubmitOptions; reason: RegExp }> = [
      {
        name: "staging",
        options: { stagedErrors: [{ message: "quota exceeded" }] },
        reason: /quota exceeded/,
      },
      {
        name: "submission",
        options: { submitErrors: [{ message: "already running" }] },
        reason: /already running/,
      },
    ];

    for (const { name, options, reason } of cases) {
      const { client, upload } = submitClient(options);

      const error = await submitBulkMutation([row()], {
        client,
        upload,
        productOf,
        sleep: noSleep,
      }).catch((caught: unknown) => caught);

      const app = toAppError(error);

      expect(app.code, `${name} should be a Shopify rejection`).toBe("SHOPIFY_REJECTED");
      // Not retryable: Shopify refused the request as posed, so a worker resending it
      // unchanged gets the same answer.
      expect(app.retryable, `${name} should not be retried by the worker`).toBe(false);
      // Shopify's own words, and never the generic sentence.
      expect(app.userMessage).toMatch(reason);
      expect(app.userMessage).not.toMatch(/Something went wrong on our side/);
      // The object, and the next action — the shape RFC §11 asks for.
      expect(app.userMessage).toMatch(/No prices were changed/);
      expect(app.userMessage).toMatch(/Run the campaign again/);
    }
  });
});

// ----------------------------------------------------------------- polling

describe("poll fallback (edge case E13)", () => {
  function pollClient(states: BulkOperationState[]) {
    let i = 0;
    const calls = { count: 0, ids: [] as unknown[], queries: [] as string[] };
    const client: AdminClient = {
      async request<T>(query: string, variables: Record<string, unknown>) {
        calls.count++;
        calls.ids.push(variables.id);
        calls.queries.push(query);
        const state = states[Math.min(i, states.length - 1)];
        i++;
        return { data: { bulkOperation: state } as T };
      },
    };
    return { client, calls };
  }

  it("polls until the operation reaches a terminal state", async () => {
    const { client, calls } = pollClient([
      { id: "1", status: "RUNNING" },
      { id: "1", status: "RUNNING" },
      { id: "1", status: "COMPLETED", url: "https://results" },
    ]);
    const final = await pollUntilTerminal({ client, id: "1", sleep: noSleep, intervalMs: 1 });
    expect(final?.status).toBe("COMPLETED");
    expect(calls.count).toBe(3);
  });

  it("follows its own operation by id, never the app's most recent one (#1054)", async () => {
    // Shopify runs several bulk mutations per app and shop at once from 2026-01, and
    // `currentBulkOperation` answers with the newest: another campaign's, as often as not.
    const { client, calls } = pollClient([
      { id: "gid://shopify/BulkOperation/7", status: "RUNNING" },
      { id: "gid://shopify/BulkOperation/7", status: "COMPLETED", url: "https://results/7" },
    ]);
    const final = await pollUntilTerminal({ client, id: "gid://shopify/BulkOperation/7", sleep: noSleep, intervalMs: 1 });

    expect(final?.url).toBe("https://results/7");
    expect(calls.ids).toEqual(["gid://shopify/BulkOperation/7", "gid://shopify/BulkOperation/7"]);
    for (const query of calls.queries) {
      expect(query).toContain("bulkOperation(id: $id)");
      expect(query).not.toContain("currentBulkOperation");
    }
  });

  it("returns the last state on timeout rather than throwing", async () => {
    // A run that may yet succeed must be reported as still-running, not failed.
    let t = 0;
    const { client } = pollClient([{ id: "1", status: "RUNNING" }]);
    const final = await pollUntilTerminal({
      client,
      id: "1",
      sleep: async () => {
        t += 10_000;
      },
      now: () => t,
      intervalMs: 1,
      timeoutMs: 15_000,
    });
    expect(final?.status).toBe("RUNNING");
  });

  it("treats FAILED, CANCELED and EXPIRED as terminal", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("CANCELED")).toBe(true);
    expect(isTerminal("EXPIRED")).toBe(true);
    expect(isTerminal("RUNNING")).toBe(false);
    expect(isTerminal("CREATED")).toBe(false);
  });
});

// ---------------------------------------------------------- waiting for a turn

describe("a submission past the app's bulk limit waits for a turn (#1054)", () => {
  const LIMIT = { field: null, message: "Bulk operations limit reached. Please try again later.", code: "LIMIT_REACHED" };
  const IN_PROGRESS = {
    field: null,
    message: "A bulk mutation operation for this app and shop is already in progress.",
    code: "OPERATION_IN_PROGRESS",
  };

  /** Refuses the first submissions with these errors, one entry each, then accepts. */
  function turnClient(refusals: Array<Array<{ field: null; message: string; code?: string }>>) {
    const seen = { staged: 0, submitted: 0, paths: [] as unknown[] };
    const client: AdminClient = {
      async request<T>(query: string, variables: Record<string, unknown>) {
        if (query.includes("stagedUploadsCreate")) {
          seen.staged++;
          return { data: { stagedUploadsCreate: { stagedTargets: [stagedTarget()], userErrors: [] } } as T };
        }
        const userErrors = refusals[seen.submitted] ?? [];
        seen.submitted++;
        seen.paths.push(variables.stagedUploadPath);
        return {
          data: {
            bulkOperationRunMutation: {
              bulkOperation: userErrors.length > 0 ? null : { id: "gid://bulk/9", status: "CREATED" },
              userErrors,
            },
          } as T,
        };
      },
    };
    const uploaded: string[] = [];
    const upload = async (_t: StagedTarget, body: string) => {
      uploaded.push(body);
    };
    return { client, upload, uploaded, seen };
  }

  it("asks again after each refusal, with the same upload, and says so each time", async () => {
    const { client, upload, uploaded, seen } = turnClient([[LIMIT], [IN_PROGRESS]]);
    const waits: string[] = [];
    const slept: number[] = [];

    const { operation } = await submitBulkMutation([row()], {
      client,
      upload,
      productOf,
      sleep: async (ms) => {
        slept.push(ms);
      },
      intervalMs: 5_000,
      onBusy: async (reason) => {
        waits.push(reason);
      },
    });

    expect(operation.id).toBe("gid://bulk/9");
    expect(waits).toEqual([LIMIT.message, IN_PROGRESS.message]);
    expect(slept).toEqual([5_000, 5_000]);
    // Refused submissions ran nothing: one staging, one upload, three asks for the same path.
    expect([seen.staged, uploaded.length, seen.submitted]).toEqual([1, 1, 3]);
    expect(new Set(seen.paths)).toEqual(new Set(["tmp/anchor-bulk.jsonl"]));
  });

  it("gives up once its wait is over, saying nothing was sent and what to do", async () => {
    let t = 0;
    const { client, upload, seen } = turnClient(Array.from({ length: 100 }, () => [LIMIT]));
    const waits: string[] = [];

    const error = await submitBulkMutation([row()], {
      client,
      upload,
      productOf,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      intervalMs: 5_000,
      waitMs: 120_000,
      onBusy: async (reason) => {
        waits.push(reason);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BulkSubmissionError);
    const app = toAppError(error);
    expect(app.userMessage).toMatch(
      /^Shopify was still running other bulk price updates for this store after this campaign had waited 2 minutes for its turn/,
    );
    expect(app.userMessage).toMatch(/No prices were changed\. Run the campaign again once they have finished\.$/);
    expect(app.retryable).toBe(false);
    // Twenty-four waits of five seconds fill the two minutes; the next refusal ends it.
    expect(waits).toHaveLength(24);
    expect(seen.submitted).toBe(25);
  });

  it("is a refusal like any other for a caller that cannot wait, or for any other reason", async () => {
    // No `onBusy`: the caller has not said it can wait, so it is told at once.
    const busy = turnClient([[LIMIT]]);
    await expect(submitBulkMutation([row()], { ...busy, productOf, sleep: noSleep })).rejects.toThrow(
      /Shopify rejected the bulk price update for this campaign: Bulk operations limit reached/,
    );

    // A refusal that is not about a turn is not waited out, even beside one that is.
    const invalid = turnClient([[LIMIT, { field: null, message: "The mutation is invalid.", code: "INVALID_MUTATION" }]]);
    const waits: string[] = [];
    await expect(
      submitBulkMutation([row()], {
        ...invalid,
        productOf,
        sleep: noSleep,
        onBusy: async (reason) => {
          waits.push(reason);
        },
      }),
    ).rejects.toThrow(/The mutation is invalid/);
    expect(waits).toEqual([]);
    expect(invalid.seen.submitted).toBe(1);
  });
});

// -------------------------------------------------------------- reconciliation

describe("reconciliation", () => {
  const results = (ids: Array<[string, string]>) =>
    ids
      .map(([id, price]) =>
        JSON.stringify({
          data: {
            productVariantsBulkUpdate: {
              productVariants: [{ id, price, compareAtPrice: null }],
              userErrors: [],
            },
          },
        }),
      )
      .join("\n");

  const fetcher = (text: string) => () => fromString(text);

  it("maps outcomes back to variants", async () => {
    const out = await reconcileResults(
      { id: "1", status: "COMPLETED", url: "https://r" },
      ["gid://v/1", "gid://v/2"],
      fetcher(results([["gid://v/1", "80.00"], ["gid://v/2", "70.00"]])),
    );
    expect(out.outcomes.size).toBe(2);
    expect(out.unreported).toEqual([]);
  });

  it("treats absence as unreported, never as success", async () => {
    // The asymmetry that stops a half-applied campaign being reported complete.
    const out = await reconcileResults(
      { id: "1", status: "COMPLETED", url: "https://r" },
      ["gid://v/1", "gid://v/2", "gid://v/3"],
      fetcher(results([["gid://v/1", "80.00"]])),
    );
    expect(out.outcomes.size).toBe(1);
    expect(out.unreported).toEqual(["gid://v/2", "gid://v/3"]);
  });

  it("uses partialDataUrl when the operation did not complete", async () => {
    // Whatever did finish is still reconciled rather than discarded.
    const out = await reconcileResults(
      { id: "1", status: "FAILED", url: null, partialDataUrl: "https://partial" },
      ["gid://v/1", "gid://v/2"],
      fetcher(results([["gid://v/1", "80.00"]])),
    );
    expect(out.outcomes.size).toBe(1);
    expect(out.unreported).toEqual(["gid://v/2"]);
  });

  it("reports everything unreported when there is no result file at all", async () => {
    const out = await reconcileResults(
      { id: "1", status: "EXPIRED", url: null, partialDataUrl: null },
      ["gid://v/1"],
      fetcher(""),
    );
    expect(out.unreported).toEqual(["gid://v/1"]);
  });

  it("collects malformed lines separately from outcomes", async () => {
    const text = `${results([["gid://v/1", "80.00"]])}\ngarbage\n`;
    const out = await reconcileResults(
      { id: "1", status: "COMPLETED", url: "https://r" },
      ["gid://v/1"],
      fetcher(text),
    );
    expect(out.outcomes.size).toBe(1);
    expect(out.malformedLines).toHaveLength(1);
  });
});

describe("scale", () => {
  it("builds a 50k-row payload without materialising it (P2.5.5 smoke)", () => {
    const rows: PlannedRow[] = [];
    for (let i = 0; i < 50_000; i++) {
      rows.push(row({ ref: ref(`gid://shopify/ProductVariant/${i}`) }));
    }
    // 10 variants per product.
    const productFor = (gid: string) =>
      `gid://shopify/Product/${Math.floor(Number(gid.split("/").pop()) / 10)}`;

    let lines = 0;
    let variants = 0;
    for (const line of buildMutationLines(rows, productFor)) {
      lines++;
      variants += line.variants.length;
    }
    expect(lines).toBe(5_000);
    expect(variants).toBe(50_000);
  });
});
