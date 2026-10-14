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
import { AppError, toAppError } from "../lib/errors/app-error";
import {
  buildMatchIndex,
  matchIdentifiers,
  type CsvRow,
} from "../lib/segments/csv-import";
import { identifierRefusal, productRefusal, readRows } from "../lib/baselines/csv-rows";
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
  /** Rows naming a variant another row also names (#767). None of them is written. */
  duplicates: CostImportProblem[];
  /**
   * Every row that needs attention, counted rather than listed. The lists stop at
   * MAX_PROBLEMS, and the report has to account for the whole file anyway: rows read =
   * ready + unchanged + this.
   */
  problems: number;
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
    duplicates: [],
    problems: 0,
    dryRun: options.dryRun === true,
  };
  const problem = (list: CostImportProblem[], entry: CostImportProblem) => {
    result.problems++;
    push(list, entry);
  };

  const variants = await prisma.variantIndex.findMany({
    where: { shopId, deletedAt: null },
    select: { variantGid: true, productGid: true, sku: true, barcode: true, cost: true },
  });
  const index = buildMatchIndex(variants);
  // The cost the guardrails read: the current baseline's, falling back to the mirror's
  // (#737). Compared with the mirror's alone, a re-import of the cost Shopify now has was
  // "already matched" while the baseline -- and so "never below cost" -- kept the old one.
  const baselineCost = new Map(
    (
      await prisma.baseline.findMany({
        where: { shopId, surfaceKind: "BASE", priceListGid: "", supersededAt: null, cost: { not: null } },
        select: { variantGid: true, cost: true },
      })
    ).map((row) => [row.variantGid, row.cost]),
  );
  const currentCost = new Map(variants.map((row) => [row.variantGid, baselineCost.get(row.variantGid) ?? row.cost]));

  // Every matched row, by variant, before anything is written (#767). A variant named
  // twice used to be written twice, the last row winning without a word; the price import
  // refuses the same file. Which row is the merchant's real cost is a question, so
  // neither is written -- and "neither" needs the whole file read first, since the first
  // row may sit in a batch written long before the second turns up. A variant id and a
  // cost a row is small enough to hold for a catalogue of any size.
  const byVariant = new Map<string, Array<{ row: ValidCostRow; line: number; identifier: string }>>();

  // Read a line at a time; nothing is written until the file has been read.
  for await (const raw of readRows(lines)) {
    result.total++;

    const validated = validateCostRow(raw, shopCurrency);
    if (!isValidCost(validated)) {
      problem(result.invalid, { line: raw.line, identifier: raw.identifier, reason: validated.reason });
      continue;
    }

    // A product handle cannot be matched to a variant, and is said so rather than
    // reported as "no match" (#735).
    const refusal = identifierRefusal(raw);
    if (refusal) {
      problem(result.unmatched, { line: raw.line, identifier: raw.identifier, reason: refusal });
      continue;
    }

    const csvRow: CsvRow = {
      line: raw.line,
      value: raw.identifier,
      column: raw.identifierColumn === "variant-id" ? "variant-id" : undefined,
    };
    const outcome = matchIdentifiers([csvRow], index);

    if (outcome.ambiguous.length > 0) {
      problem(result.ambiguous, {
        line: raw.line,
        identifier: raw.identifier,
        reason:
          `Matches ${outcome.ambiguous[0].candidates.length} variants. ` +
          `Use a variant ID, or make the SKU unique.`,
      });
      continue;
    }

    // A product id matches every variant of the product, and one row is one variant's
    // cost: refused, as the baseline import refuses it, not applied to the first (#735).
    if (outcome.matched.length > 1) {
      problem(result.ambiguous, {
        line: raw.line,
        identifier: raw.identifier,
        reason: productRefusal(outcome.matched.length, "cost"),
      });
      continue;
    }

    const variantGid = outcome.matched[0];
    if (!variantGid) {
      problem(result.unmatched, {
        line: raw.line,
        identifier: raw.identifier,
        reason: "No variant in this shop has that SKU, barcode or ID.",
      });
      continue;
    }

    const rows = byVariant.get(variantGid) ?? [];
    rows.push({ row: validated, line: raw.line, identifier: raw.identifier });
    byVariant.set(variantGid, rows);
  }

  const pending: Array<{ row: ValidCostRow; variantGid: string }> = [];
  for (const [variantGid, rows] of byVariant) {
    if (rows.length > 1) {
      for (const { line, identifier } of rows) {
        problem(result.duplicates, {
          line,
          identifier,
          reason: `This variant is listed ${rows.length} times (lines ${rows.map((r) => r.line).join(", ")}). Keep one row and import again; neither was imported.`,
        });
      }
      continue;
    }
    const [{ row }] = rows;
    // Unchanged is a real answer, not a write. Rewriting an identical cost would churn
    // the mirror's syncedAt and make the audit look like something moved.
    const existing = currentCost.get(variantGid);
    if (existing !== null && existing !== undefined && Number(existing) === row.parsedCost.amount) {
      result.unchanged++;
      continue;
    }
    result.ready++;
    pending.push({ row, variantGid });
  }

  if (!result.dryRun) {
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      try {
        await writeCosts(shopId, batch);
      } catch (error) {
        // Batches before this one are written, each in its own transaction, and the
        // merchant needs to know how far it got (#767): the same file, imported again,
        // finds those unchanged and writes the rest.
        const failed = toAppError(error);
        throw new AppError({
          code: failed.code,
          retryable: failed.retryable,
          userMessage:
            `${failed.userMessage} ${result.written} of ${pending.length} costs were written before it stopped. ` +
            "Import the same file again to finish: the costs already written will show as unchanged.",
          cause: error,
          context: { written: result.written, pending: pending.length },
        });
      }
      result.written += batch.length;
    }

    // What the import did, for Activity: counts and who, never a cost (#767).
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: options.actor ?? null,
        action: "costs.import",
        entity: "Shop",
        entityId: shopId,
        after: { total: result.total, written: result.written, unchanged: result.unchanged, problems: result.problems },
      },
    });
  }

  logger.info("costs imported", {
    shopId,
    total: result.total,
    ready: result.ready,
    written: result.written,
    unchanged: result.unchanged,
    problems: result.problems,
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
