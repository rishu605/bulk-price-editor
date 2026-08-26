/**
 * Importing exact prices, as a campaign.
 *
 * The obvious implementation — read the file, write the prices — breaks two architectural
 * rules at once: the web process never writes prices, and nothing changes without a ledger
 * row a revert can recompute from. It would also be the one path in the app with no
 * preview, no guardrails and no undo, which is the path a merchant most needs those on.
 *
 * So an import produces rows and a campaign whose rule is "look them up". Everything
 * downstream is unchanged, and gets there by being ordinary rather than by special
 * handling: preview, blast-radius confirmation, cost floors, rounding, market surfaces and
 * revert all work because a `from-import` rule is just another rule.
 *
 * Same reader, matcher, dry run and error file as the baseline and cost imports. Three
 * importers that decided "SKU-1 matches two variants" differently would be three chances
 * to be inconsistent about the thing that matters most.
 */

import prisma from "../db.server";
import { readRows } from "../lib/baselines/csv-rows";
import { isValid, validateRow } from "../lib/baselines/csv-rows";
import { buildMatchIndex, matchIdentifiers, type CsvRow } from "../lib/segments/csv-import";
import { logger } from "../lib/logging/logger";

export interface PriceImportProblem {
  line: number;
  identifier: string;
  reason: string;
}

export interface PriceImportResult {
  importId: string | null;
  total: number;
  ready: number;
  invalid: PriceImportProblem[];
  unmatched: PriceImportProblem[];
  ambiguous: PriceImportProblem[];
  /** A variant the file named twice. Refused rather than letting the last row win. */
  duplicates: PriceImportProblem[];
  dryRun: boolean;
}

const MAX_PROBLEMS = 500;
const BATCH = 1_000;

export async function importPrices(
  shopId: string,
  name: string,
  lines: AsyncIterable<string>,
  shopCurrency: string,
  options: { dryRun?: boolean; actor?: string } = {},
): Promise<PriceImportResult> {
  const result: PriceImportResult = {
    importId: null,
    total: 0,
    ready: 0,
    invalid: [],
    unmatched: [],
    ambiguous: [],
    duplicates: [],
    dryRun: options.dryRun === true,
  };

  const variants = await prisma.variantIndex.findMany({
    where: { shopId, deletedAt: null },
    select: { variantGid: true, productGid: true, sku: true, barcode: true },
  });
  const index = buildMatchIndex(variants);

  // Created up front so rows can be written in batches rather than held. On a dry run
  // nothing is created at all, which is what makes the dry run a real dry run rather
  // than a create-and-delete.
  const record = result.dryRun
    ? null
    : await prisma.priceImport.create({
        data: { shopId, name, currency: shopCurrency, createdBy: options.actor ?? null },
      });
  result.importId = record?.id ?? null;

  const seen = new Set<string>();
  let batch: Array<{ importId: string; variantGid: string; price: bigint; compareAt: bigint | null }> = [];

  const flush = async () => {
    if (batch.length === 0 || !record) return;
    const pending = batch;
    batch = [];
    await prisma.priceImportRow.createMany({ data: pending, skipDuplicates: true });
  };

  for await (const raw of readRows(lines)) {
    result.total++;

    const validated = validateRow(raw, shopCurrency);
    if (!isValid(validated)) {
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

    // A file naming a variant twice is a question, not two instructions. Letting the
    // last row win would set a price the merchant may not have meant, silently.
    if (seen.has(variantGid)) {
      push(result.duplicates, {
        line: raw.line,
        identifier: raw.identifier,
        reason: "This variant already has a price earlier in the file. Remove one of the rows.",
      });
      continue;
    }
    seen.add(variantGid);

    result.ready++;
    if (record) {
      batch.push({
        importId: record.id,
        variantGid,
        price: BigInt(validated.parsedPrice.amount),
        compareAt:
          validated.parsedCompareAt === null ? null : BigInt(validated.parsedCompareAt.amount),
      });
      if (batch.length >= BATCH) await flush();
    }
  }

  await flush();

  if (record) {
    await prisma.priceImport.update({
      where: { id: record.id },
      data: { rowsRead: result.total, rowsMatched: result.ready },
    });
  }

  logger.info("prices imported", {
    shopId,
    importId: result.importId,
    total: result.total,
    ready: result.ready,
    problems:
      result.invalid.length +
      result.unmatched.length +
      result.ambiguous.length +
      result.duplicates.length,
    dryRun: result.dryRun,
  });

  return result;
}

/**
 * The imported prices for a set of variants, keyed for the resolver.
 *
 * Loaded by the planner and passed in, because the resolver does no I/O. A variant the
 * import did not name is simply absent, and the rule reports it as skipped rather than
 * pricing it at nothing.
 */
export async function importedPricesFor(
  importId: string,
  variantGids: readonly string[],
): Promise<Map<string, { price: bigint; compareAt: bigint | null }>> {
  if (variantGids.length === 0) return new Map();

  const rows = await prisma.priceImportRow.findMany({
    where: { importId, variantGid: { in: [...variantGids] } },
    select: { variantGid: true, price: true, compareAt: true },
  });

  return new Map(rows.map((row) => [row.variantGid, { price: row.price, compareAt: row.compareAt }]));
}

/** Every variant an import names, so a campaign can be scoped to exactly them. */
export async function importedVariantGids(importId: string): Promise<string[]> {
  const rows = await prisma.priceImportRow.findMany({
    where: { importId },
    select: { variantGid: true },
  });

  return rows.map((row) => row.variantGid);
}

function push(list: PriceImportProblem[], problem: PriceImportProblem): void {
  if (list.length < MAX_PROBLEMS) list.push(problem);
}
