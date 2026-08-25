/**
 * Importing unit costs.
 *
 * The margin guardrail is the safety net merchants say they want most, and on most
 * catalogues it does nothing, because Shopify does not require a cost and a store built
 * from a supplier feed keeps its costs in the supplier's spreadsheet. "Never price below
 * cost" then silently skips every variant, which is the worst possible shape for a safety
 * feature: switched on, reassuring, and inert.
 *
 * Structurally the same as the baseline import, deliberately. Same row reader, same
 * matcher, same dry run, same row-level error file — so "SKU-1 matches two variants"
 * means one thing in this app rather than being decided twice, differently.
 *
 * Costs are written to the catalogue mirror and to the current baseline. The baseline is
 * what the guardrail reads at resolve time; the mirror is what the settings page counts
 * to tell a merchant how much of their catalogue the guardrail can actually protect.
 */

import prisma from "../db.server";
import {
  buildMatchIndex,
  matchIdentifiers,
  type CsvRow,
} from "../lib/segments/csv-import";
import { readRows } from "../lib/baselines/csv-rows";
import { isValidCost, validateCostRow, type ValidCostRow } from "../lib/baselines/cost-rows";
import { logger } from "../lib/logging/logger";

export interface CostImportProblem {
  line: number;
  identifier: string;
  reason: string;
}

export interface CostImportResult {
  total: number;
  ready: number;
  written: number;
  /** Rows whose cost already equals the one on file. */
  unchanged: number;
  invalid: CostImportProblem[];
  unmatched: CostImportProblem[];
  ambiguous: CostImportProblem[];
  dryRun: boolean;
}

/** Rows per write. Large enough to be quick, small enough not to hold the file. */
const BATCH = 500;

export async function importCosts(
  shopId: string,
  lines: AsyncIterable<string>,
  shopCurrency: string,
  options: { dryRun?: boolean; actor?: string } = {},
): Promise<CostImportResult> {
  const result: CostImportResult = {
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
    select: { variantGid: true, productGid: true, sku: true, barcode: true, cost: true },
  });
  const index = buildMatchIndex(variants);
  const currentCost = new Map(variants.map((row) => [row.variantGid, row.cost]));

  let batch: Array<{ row: ValidCostRow; variantGid: string }> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const pending = batch;
    batch = [];
    if (result.dryRun) return;

    await writeCosts(shopId, pending);
    result.written += pending.length;
  };

  // Streamed. The file is consumed a line at a time and never assembled, so a 500K-row
  // import costs one batch of memory rather than the whole spreadsheet.
  for await (const raw of readRows(lines)) {
    result.total++;

    const validated = validateCostRow(raw, shopCurrency);
    if (!isValidCost(validated)) {
      push(result.invalid, { line: raw.line, identifier: raw.identifier, reason: validated.reason });
      continue;
    }

    const csvRow: CsvRow = { line: raw.line, value: raw.identifier };
    const outcome = matchIdentifiers([csvRow], index);

    if (outcome.ambiguous.length > 0) {
      push(result.ambiguous, {
        line: raw.line,
        identifier: raw.identifier,
        reason:
          `Matches ${outcome.ambiguous[0].candidates.length} variants. ` +
          `Use a variant ID, or make the SKU unique.`,
      });
      continue;
    }

    const variantGid = outcome.matched[0];
    if (!variantGid) {
      push(result.unmatched, {
        line: raw.line,
        identifier: raw.identifier,
        reason: "No variant in this shop has that SKU, barcode or ID.",
      });
      continue;
    }

    // Unchanged is a real answer, not a write. Rewriting an identical cost would churn
    // the mirror's syncedAt and make the audit look like something moved.
    const existing = currentCost.get(variantGid);
    if (existing !== null && existing !== undefined && Number(existing) === validated.parsedCost.amount) {
      result.unchanged++;
      continue;
    }

    result.ready++;
    batch.push({ row: validated, variantGid });
    if (batch.length >= BATCH) await flush();
  }

  await flush();

  logger.info("costs imported", {
    shopId,
    total: result.total,
    ready: result.ready,
    written: result.written,
    unchanged: result.unchanged,
    problems: result.invalid.length + result.unmatched.length + result.ambiguous.length,
    dryRun: result.dryRun,
  });

  return result;
}

async function writeCosts(
  shopId: string,
  rows: ReadonlyArray<{ row: ValidCostRow; variantGid: string }>,
): Promise<void> {
  await prisma.$transaction(
    rows.flatMap(({ row, variantGid }) => [
      prisma.variantIndex.updateMany({
        where: { shopId, variantGid },
        data: { cost: BigInt(row.parsedCost.amount) },
      }),
      // The baseline is what the guardrail actually reads at resolve time. Updating the
      // mirror alone would leave "never price below cost" using whatever cost was known
      // when the baseline was captured, which is usually none.
      prisma.baseline.updateMany({
        where: { shopId, variantGid, supersededAt: null },
        data: { cost: BigInt(row.parsedCost.amount) },
      }),
    ]),
  );
}

/**
 * Keeps a bounded number of problems.
 *
 * A file that is wrong in five hundred thousand ways should produce a usable error list
 * and a count, not an out-of-memory. The first few hundred are enough to see the shape
 * of what went wrong, which is what the merchant needs in order to fix the spreadsheet.
 */
const MAX_PROBLEMS = 500;

function push(list: CostImportProblem[], problem: CostImportProblem): void {
  if (list.length < MAX_PROBLEMS) list.push(problem);
}
