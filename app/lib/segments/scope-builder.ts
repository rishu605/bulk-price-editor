/**
 * The filter builder's form, read and written (#817, PRD A-2.1 and A-2.3, D32).
 *
 * The engine scoped by sixteen conditions in AND groups joined by OR, and the editor and the
 * Segments form offered five and three of them, one value each, ANDed. A merchant could not
 * say "type Boots or type Gloves", "stock of 50 or more", leave drafts out of a segment, or put
 * the four products they had in mind into a sale. One builder now serves both forms, and this
 * is its one reading: the editor's create action, the live preview, the full preview, the
 * Segments form and its live count all build the scope here, so a condition the preview
 * prices is a condition the campaign keeps (rule 4, on the inputs).
 *
 * The builder posts one field, `scope`, holding its groups as JSON. A form without it -- a link
 * from before the builder, a test posting `tag` -- is read the old way (`astFrom`), so a scope
 * built with yesterday's controls compiles to yesterday's AST.
 *
 * Plain data and no server imports, so the component and the server read the same names.
 */

import type { Condition, ConditionField, FilterAst } from "../../services/segments.server";
import { astFrom, SCOPE_CONDITION_FIELDS, type FieldReader } from "../campaigns/draft-form";

/** The form field the builder posts. */
export const SCOPE_FIELD = "scope";

/**
 * The conditions the builder offers: every `ConditionField` that ships (D32).
 *
 * Not `priceMin`, `priceMax` or `hasCompareAt`, which read the live price and compare-at a
 * campaign writes, and so move a campaign's own variants out of its scope as it prices them;
 * nor `variantGid`, which the product picker sets. Written down a second time in
 * `scope-builder.test.ts`, on purpose: adding one here says a merchant is meant to set it.
 */
export const BUILDER_FIELDS = [
  "collection",
  "tag",
  "excludeTag",
  "vendor",
  "productType",
  "status",
  "title",
  "sku",
  "barcode",
  "inventoryMin",
  "inventoryMax",
  "hasCost",
] as const satisfies readonly ConditionField[];

export type BuilderField = (typeof BUILDER_FIELDS)[number];

/** The facet lists a `pick` field offers, as `facets()` returns them. */
export type FacetList = "collections" | "tags" | "vendors" | "productTypes";

/**
 * How a field takes its value. `pick` chooses one or more from the store's own values;
 * `contains` is typed text; `whole` a whole number; `status` and `yesNo` a fixed choice.
 */
export type FieldKind =
  | { kind: "pick"; facet: FacetList }
  | { kind: "contains" }
  | { kind: "whole" }
  | { kind: "status" }
  | { kind: "yesNo"; yes: string; no: string };

export interface FieldSpec {
  /** What the row's first select says. A phrase the value finishes. */
  label: string;
  input: FieldKind;
  /** Under the value: what several values mean, or what the field reads. */
  details?: string;
}

export const FIELD_SPECS: Record<BuilderField, FieldSpec> = {
  collection: { label: "In collection", input: { kind: "pick", facet: "collections" }, details: "Any of these." },
  tag: { label: "Tagged", input: { kind: "pick", facet: "tags" }, details: "Any of these." },
  // Said as the exception it is, as the editor's old "Except anything tagged" was.
  excludeTag: {
    input: { kind: "pick", facet: "tags" },
    label: "Not tagged",
    details: "None of these. They stay eligible for your other campaigns.",
  },
  vendor: { label: "Vendor is", input: { kind: "pick", facet: "vendors" }, details: "Any of these." },
  productType: { label: "Product type is", input: { kind: "pick", facet: "productTypes" }, details: "Any of these." },
  status: {
    label: "Product status is",
    input: { kind: "status" },
    // A campaign also has the draft and archived boxes (#751): both have to allow a status.
    details: "In a campaign, draft and archived products also need their box ticked below.",
  },
  title: { label: "Title contains", input: { kind: "contains" } },
  sku: { label: "SKU contains", input: { kind: "contains" } },
  barcode: { label: "Barcode contains", input: { kind: "contains" } },
  inventoryMin: {
    label: "Stock at least",
    input: { kind: "whole" },
    details: "Units in stock across locations, as Anchor last read them from Shopify.",
  },
  inventoryMax: {
    label: "Stock at most",
    input: { kind: "whole" },
    details: "Units in stock across locations, as Anchor last read them from Shopify.",
  },
  hasCost: {
    label: "Cost per item",
    input: { kind: "yesNo", yes: "is recorded", no: "is not recorded" },
    details: "Narrow a price-from-cost campaign to the products it can price.",
  },
};

/** Shopify's product statuses, as the status field offers them. */
export const STATUS_CHOICES = [
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "ARCHIVED", label: "Archived" },
] as const;

/** One row of a group: a field and what it was given. Values as typed or picked. */
export interface BuilderCondition {
  field: BuilderField;
  values: string[];
}

/** Rows that must all hold. */
export interface BuilderGroup {
  conditions: BuilderCondition[];
}

/**
 * What the builder holds: groups joined by OR, and the variants picked to add to the scope
 * or leave out of it. Variant ids are full gids here; `encodeScope` shortens them.
 */
export interface ScopeDraft {
  groups: BuilderGroup[];
  include: string[];
  exclude: string[];
}

export const EMPTY_SCOPE: ScopeDraft = { groups: [], include: [], exclude: [] };

/**
 * How many variants each picked list holds.
 *
 * The full preview carries the form in its link, and a request line past 16KB is refused by
 * Node before the app sees it. A hundred ids is under 2KB. A longer list is a list segment,
 * which pins any number and is the PRD's answer for a file of SKUs (A-2.4).
 */
export const MAX_PICKED = 100;
/** Past these, a form is not one a merchant built by hand. Refused by name rather than read. */
export const MAX_GROUPS = 10;
export const MAX_CONDITIONS = 12;
export const MAX_VALUES = 50;

const VARIANT_PREFIX = "gid://shopify/ProductVariant/";

/** A variant gid as the form carries it: its number, or the gid where it is not one of Shopify's. */
function shortId(gid: string): string {
  return gid.startsWith(VARIANT_PREFIX) ? gid.slice(VARIANT_PREFIX.length) : gid;
}

function longId(id: string): string {
  return id.startsWith("gid://") ? id : `${VARIANT_PREFIX}${id}`;
}

/** The builder as its hidden field posts it. */
export function encodeScope(draft: ScopeDraft): string {
  return JSON.stringify({
    groups: draft.groups.map((group) => ({
      conditions: group.conditions.map((condition) => ({ field: condition.field, values: condition.values })),
    })),
    include: draft.include.map(shortId),
    exclude: draft.exclude.map(shortId),
  });
}

/** What the form's scope says: the AST, or why it cannot be used, naming the field. */
export type ScopeReading = { ok: true; ast: FilterAst; draft: ScopeDraft } | { ok: false; problem: string; draft: ScopeDraft };

const isField = (value: unknown): value is BuilderField =>
  typeof value === "string" && (BUILDER_FIELDS as readonly string[]).includes(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/**
 * The builder's field, read back into what it holds. A field it does not offer is dropped;
 * so is a blank value, as a blank field always was. Nothing here judges a value: that is
 * `astOfDraft`, so one sentence names a bad one wherever it is read.
 */
export function decodeScope(raw: string): ScopeDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as { groups?: unknown; include?: unknown; exclude?: unknown };

  const groups = (Array.isArray(body.groups) ? body.groups : []).map((group) => ({
    conditions: (Array.isArray((group as { conditions?: unknown })?.conditions) ? (group as { conditions: unknown[] }).conditions : [])
      .map((condition) => condition as { field?: unknown; values?: unknown })
      .filter((condition) => isField(condition.field))
      .map((condition) => ({
        field: condition.field as BuilderField,
        values: strings(condition.values).map((value) => value.trim()).filter(Boolean),
      })),
  }));

  return {
    groups,
    include: strings(body.include).map(longId),
    exclude: strings(body.exclude).map(longId),
  };
}

/** A whole number as typed, or null. "50", "-3"; not "5.5", "", "fifty". */
function wholeNumber(text: string): number | null {
  return /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}

/**
 * The AST a draft describes, or the sentence that says why it cannot be used.
 *
 * One value of a picked field stays a string and several become a list, so a scope of one
 * value is the AST a scope always was. "Not tagged" with several tags is several conditions,
 * each the `excludeTag` every release reads. Picked variants are an OR group of their own,
 * added to whatever the conditions match; variants left out hold over every group.
 */
export function astOfDraft(draft: ScopeDraft): ScopeReading {
  const refuse = (problem: string): ScopeReading => ({ ok: false, problem, draft });

  if (draft.groups.length > MAX_GROUPS) return refuse(`This scope has ${draft.groups.length} "or" groups. Use ${MAX_GROUPS} or fewer.`);
  for (const [list, noun] of [
    [draft.include, "to add"],
    [draft.exclude, "to leave out"],
  ] as const) {
    if (list.length > MAX_PICKED) {
      return refuse(
        `${list.length} variants are picked ${noun}, and up to ${MAX_PICKED} can be picked here. For a longer list, make a list segment under Settings → Segments and choose it instead.`,
      );
    }
  }

  const groups: FilterAst["groups"] = [];
  for (const group of draft.groups) {
    if (group.conditions.length > MAX_CONDITIONS) {
      return refuse(`A group has ${group.conditions.length} conditions. Use ${MAX_CONDITIONS} or fewer, or split it into "or" groups.`);
    }
    const conditions: Condition[] = [];
    for (const { field, values } of group.conditions) {
      const spec = FIELD_SPECS[field];
      const given = values.map((value) => value.trim()).filter(Boolean);
      if (given.length === 0) continue;
      if (given.length > MAX_VALUES) return refuse(`"${spec.label}" has ${given.length} values. Choose ${MAX_VALUES} or fewer.`);

      switch (spec.input.kind) {
        case "pick":
          if (field === "excludeTag") for (const tag of given) conditions.push({ field, value: tag });
          else conditions.push({ field, value: given.length === 1 ? given[0] : given });
          break;
        case "contains":
          conditions.push({ field, value: given[0] });
          break;
        case "status": {
          const status = given[0].toUpperCase();
          if (!STATUS_CHOICES.some((choice) => choice.value === status)) return refuse(`"${given[0]}" is not a product status. Choose Active, Draft or Archived.`);
          conditions.push({ field, value: status });
          break;
        }
        case "whole": {
          const number = wholeNumber(given[0]);
          if (number === null) return refuse(`${spec.label} "${given[0]}" is not a whole number. Enter one, such as 50.`);
          conditions.push({ field, value: number });
          break;
        }
        case "yesNo":
          conditions.push({ field, value: given[0] === "yes" });
          break;
      }
    }
    if (conditions.length > 0) groups.push({ conditions });
  }

  if (draft.include.length > 0) groups.push({ conditions: [{ field: "variantGid", value: [...draft.include] }] });

  return {
    ok: true,
    draft,
    ast: { groups, ...(draft.exclude.length > 0 ? { excludeVariantGids: [...draft.exclude] } : {}) },
  };
}

/**
 * The scope a form or a link describes.
 *
 * The builder's field where there is one. Otherwise the fields the editor had before it
 * (`astFrom`): a bookmarked link, or a form posting `tag` as the chaos scenarios do, means
 * what it always meant.
 */
export function scopeFrom(read: FieldReader): ScopeReading {
  const raw = read(SCOPE_FIELD);
  if (raw === null || raw.trim() === "") {
    return { ok: true, ast: astFrom(read), draft: legacyDraft(read) };
  }
  const draft = decodeScope(raw);
  if (!draft) {
    return { ok: false, problem: "The products to price could not be read. Reload the page and set them again.", draft: EMPTY_SCOPE };
  }
  return astOfDraft(draft);
}

/** The editor's old fields as one group, in the order `astFrom` reads them. */
function legacyDraft(read: FieldReader): ScopeDraft {
  const conditions = SCOPE_CONDITION_FIELDS.map((field) => ({ field, values: [(read(field) ?? "").trim()].filter(Boolean) })).filter(
    (condition) => condition.values.length > 0,
  );
  return { ...EMPTY_SCOPE, groups: conditions.length > 0 ? [{ conditions }] : [] };
}

/**
 * A stored AST as the builder shows it, for editing a segment or reopening the editor.
 *
 * A group that is only picked variants is the picked list; the variants left out are the
 * other list. Several `excludeTag` conditions in a group are one "Not tagged" row, which means
 * the same thing. A condition the builder does not offer is left out of the rows.
 */
export function draftOfAst(stored: unknown): ScopeDraft {
  const ast = (stored ?? {}) as Partial<FilterAst>;
  const include: string[] = [];
  const groups: BuilderGroup[] = [];

  for (const group of ast.groups ?? []) {
    const conditions = group?.conditions ?? [];
    if (conditions.length === 1 && conditions[0]?.field === "variantGid") {
      include.push(...strings(conditions[0].value));
      continue;
    }
    const rows: BuilderCondition[] = [];
    for (const condition of conditions) {
      if (!isField(condition?.field)) continue;
      const values = (Array.isArray(condition.value) ? condition.value : [condition.value]).map((value) =>
        typeof value === "boolean" ? (value ? "yes" : "no") : String(value),
      );
      const merged = condition.field === "excludeTag" ? rows.find((row) => row.field === "excludeTag") : undefined;
      if (merged) merged.values.push(...values);
      else rows.push({ field: condition.field, values });
    }
    if (rows.length > 0) groups.push({ conditions: rows });
  }

  return { groups, include, exclude: [...(ast.excludeVariantGids ?? [])] };
}

/**
 * Whether a form's builder narrows the scope below the whole catalogue, for the guided
 * first campaign (#624). Any condition but "Not tagged", or a picked product, as the old
 * fields counted every condition but the exception.
 */
export function builderNarrows(read: FieldReader): boolean {
  const raw = read(SCOPE_FIELD);
  if (raw === null || raw.trim() === "") return false;
  const draft = decodeScope(raw);
  if (!draft) return false;
  return (
    draft.include.length > 0 ||
    draft.groups.some((group) => group.conditions.some((condition) => condition.field !== "excludeTag" && condition.values.length > 0))
  );
}
