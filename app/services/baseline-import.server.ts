/**
 * Importing a merchant's own reference prices.
 *
 * Baselines captured at install are whatever the storefront happened to be showing that
 * day. For a merchant who maintains MSRP in an ERP, that is the wrong number — and it
 * is the number every campaign computes from forever after. Importing lets "20% off
 * MSRP" mean exactly that.
 *
 * Two things this refuses to do, both for the same reason: a baseline is permanent, and
 * a wrong one silently mis-prices a product on every campaign from here on.
 *
 *   It never guesses a match. A SKU that names two variants is a question, not a match.
 *
 *   It never half-applies. Dry run is not a nicety bolted on afterwards — it is the
 *   same code path with the write skipped, so what the merchant reviews is what happens.
 */

import prisma from "../db.server";
import {
  buildMatchIndex,
  matchIdentifiers,
  type AmbiguousRow,
  type CsvRow,
} from "../lib/segments/csv-import";
import {
  isValid,
  readRows,
  validateRow,
  type InvalidRow,
  type ValidRow,
} from "../lib/baselines/csv-rows";
import { logger } from "../lib/logging/logger";

export interface ImportProblem {
  line: number;
  identifier: string;
  reason: string;
}

export interface BaselineImportResult {
  /** Rows read from the file, excluding a header. */
  total: number;
  /** Rows that validated, matched exactly one variant, and would be written. */
  ready: number;
  /** Rows written. Zero on a dry run, by construction. */
  written: number;
  /** Rows whose new baseline equals the current one, so nothing changes. */
  unchanged: number;
  invalid: ImportProblem[];
  unmatched: ImportProblem[];
  ambiguous: ImportProblem[];
  dryRun: boolean;
}

export interface ImportOptions {
  /** Show what would change and write nothing. */
  dryRun?: boolean;
  actor?: string;
}

/** Rows held before a flush. Bounded so a 500K-row file never lands in memory whole. */
const BATCH = 500;

export async function importBaselines(
  shopId: string,
  lines: AsyncIterable<string>,
  shopCurrency: string,
  options: ImportOptions = {},
): Promise<BaselineImportResult> {
  const result: BaselineImportResult = {
    total: 0,
    ready: 0,
    written: 0,
    unchanged: 0,
    invalid: [],
    unmatched: [],
    ambiguous: [],
    dryRun: options.dryRun === true,
  };

  const variants = await prisma.variantIndex.findMany({
    where: { shopId, deletedAt: null },
    select: { variantGid: true, productGid: true, sku: true, barcode: true },
  });
  const index = buildMatchIndex(variants);

  // What each variant's baseline is now, so "unchanged" is a real answer rather than a
  // rewrite. Re-capturing an identical baseline would supersede the existing row and
  // lose the date it was first established.
  const current = new Map(
    (
      await prisma.baseline.findMany({
        where: { shopId, supersededAt: null, surfaceKind: "BASE" },
        select: { variantGid: true, basePrice: true, baseCompareAt: true },
      })
    ).map((row) => [row.variantGid, row]),
  );

  let batch: Array<{ row: ValidRow; variantGid: string }> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const pending = batch;
    batch = [];
    if (result.dryRun) return;

    await writeBaselines(shopId, pending, options.actor);
    result.written += pending.length;
  };

  for await (const raw of readRows(lines)) {
    result.total++;

    const validated = validateRow(raw, shopCurrency);
    if (!isValid(validated)) {
      record(result.invalid, validated);
      continue;
    }

    // The same matcher segments use, so "SKU-1 matches two variants" means the same
    // thing in both places rather than being decided twice, differently.
    const csvRow: CsvRow = { line: raw.line, value: raw.identifier };
    const outcome = matchIdentifiers([csvRow], index);

    if (outcome.ambiguous.length > 0) {
      record(result.ambiguous, {
        line: raw.line,
        identifier: raw.identifier,
        reason: ambiguousReason(outcome.ambiguous[0]),
      });
      continue;
    }

    if (outcome.matched.length === 0) {
      record(result.unmatched, {
        line: raw.line,
        identifier: raw.identifier,
        reason: "Nothing in your catalogue answers to this SKU, barcode or ID.",
      });
      continue;
    }

    if (outcome.matched.length > 1) {
      // A product gid naming several variants. Legitimate for a segment — "everything
      // in this product" — and meaningless for a baseline, where one row would have to
      // mean one price for several different variants.
      record(result.ambiguous, {
        line: raw.line,
        identifier: raw.identifier,
        reason:
          `This is a product, not a variant — it covers ${outcome.matched.length} variants ` +
          `which would all get the same baseline. List each variant's SKU instead.`,
      });
      continue;
    }

    const variantGid = outcome.matched[0];
    const existing = current.get(variantGid);

    if (
      existing &&
      existing.basePrice === BigInt(validated.parsedPrice.amount) &&
      (existing.baseCompareAt ?? null) ===
        (validated.parsedCompareAt ? BigInt(validated.parsedCompareAt.amount) : null)
    ) {
      result.unchanged++;
      continue;
    }

    result.ready++;
    batch.push({ row: validated, variantGid });
    if (batch.length >= BATCH) await flush();
  }

  await flush();

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: options.actor ?? null,
      action: result.dryRun ? "baselines.import.dry-run" : "baselines.import",
      entity: "Shop",
      entityId: shopId,
      after: {
        total: result.total,
        ready: result.ready,
        written: result.written,
        unchanged: result.unchanged,
        invalid: result.invalid.length,
        unmatched: result.unmatched.length,
        ambiguous: result.ambiguous.length,
      },
    },
  });

  logger.info("baselines imported", { shopId, ...summary(result) });
  return result;
}

/** Caps what is kept for the report. The count is exact; the list is a sample. */
const MAX_REPORTED = 5_000;

function record(into: ImportProblem[], problem: ImportProblem | InvalidRow): void {
  if (into.length >= MAX_REPORTED) return;
  into.push({
    line: problem.line,
    identifier: "identifier" in problem ? problem.identifier : "",
    reason: problem.reason,
  });
}

function ambiguousReason(row: AmbiguousRow): string {
  return (
    `This ${row.kind === "barcode" ? "barcode" : "SKU"} matches ${row.candidates.length} variants. ` +
    `Choosing one could set the wrong product's baseline permanently, so the row was left out — ` +
    `use the variant ID instead.`
  );
}

function summary(result: BaselineImportResult) {
  return {
    total: result.total,
    ready: result.ready,
    written: result.written,
    unchanged: result.unchanged,
    invalid: result.invalid.length,
    unmatched: result.unmatched.length,
    ambiguous: result.ambiguous.length,
    dryRun: result.dryRun,
  };
}

/**
 * Writes a batch of baselines.
 *
 * Append-only: the previous baseline is superseded rather than updated, so what a
 * variant's reference price used to be — and when it changed — survives. That history
 * is what makes a campaign from six weeks ago explicable.
 */
async function writeBaselines(
  shopId: string,
  rows: Array<{ row: ValidRow; variantGid: string }>,
  actor?: string,
): Promise<void> {
  const now = new Date();

  await prisma.$transaction([
    prisma.baseline.updateMany({
      where: {
        shopId,
        surfaceKind: "BASE",
        supersededAt: null,
        variantGid: { in: rows.map((r) => r.variantGid) },
      },
      data: { supersededAt: now },
    }),
    prisma.baseline.createMany({
      data: rows.map(({ row, variantGid }) => ({
        shopId,
        variantGid,
        surfaceKind: "BASE" as const,
        priceListGid: "",
        currency: row.parsedPrice.currency,
        basePrice: BigInt(row.parsedPrice.amount),
        baseCompareAt: row.parsedCompareAt ? BigInt(row.parsedCompareAt.amount) : null,
        source: "CSV_IMPORT" as const,
        capturedBy: actor ?? null,
      })),
    }),
  ]);
}

// The error file itself lives in lib/reporting so the browser can build the download;
// see that module for why a resource route cannot serve it.
export { importErrorCsv } from "../lib/reporting/baseline-errors";
