import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import type { PlannedRow, SurfaceRef } from "../planning/types";
import {
  buildMutationLines,
  collect,
  fromString,
  parseResults,
  serializeJsonl,
  streamLines,
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
    const op = await submitBulkMutation([row()], { client, upload, productOf, sleep: noSleep });
    expect(op.id).toBe("gid://bulk/1");
    expect(uploaded).toHaveLength(1);
    expect(JSON.parse(uploaded[0].trim())).toMatchObject({ productId: "gid://shopify/Product/A" });
  });

  it("refuses to submit an empty payload", async () => {
    const { client, upload } = submitClient();
    await expect(
      submitBulkMutation([row({ status: "skipped", intendedPrice: undefined })], {
        client,
        upload,
        productOf,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(BulkSubmissionError);
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
    const { client, upload } = submitClient({ noKey: true });
    await expect(
      submitBulkMutation([row()], { client, upload, productOf, sleep: noSleep }),
    ).rejects.toThrow(/key/);
  });
});

// ----------------------------------------------------------------- polling

describe("poll fallback (edge case E13)", () => {
  function pollClient(states: BulkOperationState[]) {
    let i = 0;
    const calls = { count: 0 };
    const client: AdminClient = {
      async request<T>() {
        calls.count++;
        const state = states[Math.min(i, states.length - 1)];
        i++;
        return { data: { currentBulkOperation: state } as T };
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
    const final = await pollUntilTerminal({ client, sleep: noSleep, intervalMs: 1 });
    expect(final?.status).toBe("COMPLETED");
    expect(calls.count).toBe(3);
  });

  it("returns the last state on timeout rather than throwing", async () => {
    // A run that may yet succeed must be reported as still-running, not failed.
    let t = 0;
    const { client } = pollClient([{ id: "1", status: "RUNNING" }]);
    const final = await pollUntilTerminal({
      client,
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
