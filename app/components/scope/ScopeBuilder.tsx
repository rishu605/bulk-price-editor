import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { facetDetails, type Facets } from "../../lib/segments/facets";
import { addPicked, variantsPicked, type PickedProduct } from "../../lib/segments/picker";
import {
  BUILDER_FIELDS,
  encodeScope,
  FIELD_SPECS,
  MAX_PICKED,
  SCOPE_FIELD,
  STATUS_CHOICES,
  type BuilderField,
  type ScopeDraft,
} from "../../lib/segments/scope-builder";
import { PAD, SPACE } from "../../lib/ui/spacing";
import { ActionRow } from "../ActionRow";
import { FieldGrid, FullRow } from "../FieldGrid";
import { Secondary } from "../Type";

/**
 * The filter builder (#817, PRD A-2.1 and A-2.3, D32): the editor's "Which products" and the
 * Segments form, one component.
 *
 * Rows that must all hold, in groups any of which may: "Tagged sale, stock at least 50" or
 * "Product type Boots or Gloves". A picked field takes several values, as chips, meaning any of
 * them. The product picker adds variants to the scope or leaves them out of it.
 *
 * The whole thing posts as one hidden field (`scope`), read by `scopeFrom` on the server for
 * the preview, the count and the save alike. It is held in state here, because a group a
 * merchant adds is a control that did not exist when the page rendered. Its fields carry no
 * name, so nothing posts twice. Every change also says so as a native `change` on the hidden
 * field: the editor listens for those on its form (#863), and a button press or a removed chip
 * fires none of its own.
 */
export function ScopeBuilder({
  facets,
  initial,
  pickedTitles = {},
  onChange,
  count,
  disabled = false,
}: {
  facets: Facets;
  initial: ScopeDraft;
  /** Names of the variants `initial` has picked, by gid. The loader reads them. */
  pickedTitles?: Record<string, string>;
  /** Called with the field's value whenever it changes, for a page counting it itself. */
  onChange?: (encoded: string) => void;
  /** The live count, under everything it counts. */
  count?: ReactNode;
  disabled?: boolean;
}) {
  const [groups, setGroups] = useState<GroupState[]>(() =>
    initial.groups.map((group) => ({ id: nextId(), rows: group.conditions.map((row) => ({ id: nextId(), ...row })) })),
  );
  const [include, setInclude] = useState<string[]>(initial.include);
  const [exclude, setExclude] = useState<string[]>(initial.exclude);
  const [titles, setTitles] = useState<Record<string, string>>(pickedTitles);
  const [pickNote, setPickNote] = useState<string | null>(null);

  const encoded = useMemo(
    () =>
      encodeScope({
        groups: groups.map((group) => ({ conditions: group.rows.map(({ field, values }) => ({ field, values })) })),
        include,
        exclude,
      }),
    [groups, include, exclude],
  );

  // Said to the form after the first render only: the value it rendered with is not a change.
  const hidden = useRef<HTMLInputElement>(null);
  const rendered = useRef(false);
  const latestOnChange = useRef(onChange);
  useEffect(() => {
    latestOnChange.current = onChange;
  }, [onChange]);
  useEffect(() => {
    if (!rendered.current) {
      rendered.current = true;
      return;
    }
    hidden.current?.dispatchEvent(new Event("change", { bubbles: true }));
    latestOnChange.current?.(encoded);
  }, [encoded]);

  const editGroup = (groupId: number, edit: (rows: RowState[]) => RowState[]) =>
    setGroups((current) => current.map((group) => (group.id === groupId ? { ...group, rows: edit(group.rows) } : group)));
  const editRow = (groupId: number, rowId: number, edit: (row: RowState) => RowState) =>
    editGroup(groupId, (rows) => rows.map((row) => (row.id === rowId ? edit(row) : row)));
  const newRow = (): RowState => ({ id: nextId(), field: "collection", values: [] });

  const addGroup = () => setGroups((current) => [...current, { id: nextId(), rows: [newRow()] }]);
  const removeRow = (groupId: number, rowId: number) =>
    setGroups((current) =>
      current
        .map((group) => (group.id === groupId ? { ...group, rows: group.rows.filter((row) => row.id !== rowId) } : group))
        // A group with no rows left is gone: an empty group would read as "or anything".
        .filter((group) => group.rows.length > 0),
    );

  /**
   * App Bridge's product picker, adding to one of the lists. Absent outside the admin -- a
   * render test -- where the buttons say nothing happened rather than throwing.
   */
  const pick = async (into: "include" | "exclude") => {
    if (typeof shopify === "undefined") return;
    const picked = await shopify.resourcePicker({ type: "product", action: "add", multiple: true, filter: { variants: true } });
    if (!picked) return;
    const variants = variantsPicked(picked as unknown as PickedProduct[]);
    setTitles((current) => ({ ...current, ...Object.fromEntries(variants.map((variant) => [variant.gid, variant.title])) }));
    const { list, leftOver } = addPicked(into === "include" ? include : exclude, variants);
    (into === "include" ? setInclude : setExclude)(list);
    setPickNote(
      leftOver > 0
        ? `${leftOver} more ${leftOver === 1 ? "variant was" : "variants were"} not added: up to ${MAX_PICKED} can be picked here. For a longer list, make a list segment under Settings → Segments.`
        : null,
    );
  };

  return (
    <s-stack gap={SPACE.section}>
      <input ref={hidden} type="hidden" name={SCOPE_FIELD} value={encoded} readOnly />

      <Secondary>
        Every condition in a group must hold, and a product that matches any group is in. With no
        conditions, this covers every product.
      </Secondary>

      {groups.map((group, index) => (
        <Fragment key={group.id}>
          {/* Between groups, said as the word it is: any group may hold. */}
          {index > 0 ? <s-text type="strong">or</s-text> : null}
          <s-box border="base" borderRadius="base" padding={PAD.card}>
            <s-stack gap={SPACE.section}>
              {group.rows.map((row, rowIndex) => (
                <ConditionRow
                  key={row.id}
                  row={row}
                  facets={facets}
                  // Inside a group, every row holds: said on each row after the first.
                  joined={rowIndex > 0}
                  disabled={disabled}
                  onField={(field) => editRow(group.id, row.id, () => ({ id: row.id, field, values: field === "hasCost" ? ["yes"] : [] }))}
                  onValues={(values) => editRow(group.id, row.id, (current) => ({ ...current, values }))}
                  onRemove={() => removeRow(group.id, row.id)}
                />
              ))}
              <ActionRow>
                <s-button icon="plus" disabled={disabled || undefined} onClick={() => editGroup(group.id, (rows) => [...rows, newRow()])}>
                  And another condition
                </s-button>
              </ActionRow>
            </s-stack>
          </s-box>
        </Fragment>
      ))}

      <ActionRow>
        <s-button icon="plus" disabled={disabled || undefined} onClick={addGroup}>
          {groups.length === 0 ? "Add a condition" : "Or another group"}
        </s-button>
      </ActionRow>

      <PickedList
        heading="Products added"
        about="Added to whatever the conditions match. With no conditions, only the products picked here are covered."
        gids={include}
        titles={titles}
        disabled={disabled}
        pickLabel="Add products"
        onPick={() => void pick("include")}
        onRemove={(gid) => setInclude((current) => current.filter((item) => item !== gid))}
      />
      <PickedList
        heading="Products left out"
        about="Left out whatever the conditions say. They stay eligible for your other campaigns."
        gids={exclude}
        titles={titles}
        disabled={disabled}
        pickLabel="Leave products out"
        onPick={() => void pick("exclude")}
        onRemove={(gid) => setExclude((current) => current.filter((item) => item !== gid))}
      />
      {pickNote ? (
        <s-paragraph>
          <s-text tone="caution">{pickNote}</s-text>
        </s-paragraph>
      ) : null}

      {count}
    </s-stack>
  );
}

/**
 * Keys for rows and groups, which have no identity of their own. Counted across the page rather
 * than per builder: a key only has to differ from its siblings', and a ref read while rendering
 * the first state is a value React does not track.
 */
let lastId = 0;
const nextId = () => ++lastId;

interface RowState {
  id: number;
  field: BuilderField;
  values: string[];
}

interface GroupState {
  id: number;
  rows: RowState[];
}

/** One condition: which field, and its value. */
function ConditionRow({
  row,
  facets,
  joined,
  disabled,
  onField,
  onValues,
  onRemove,
}: {
  row: RowState;
  facets: Facets;
  joined: boolean;
  disabled: boolean;
  onField: (field: BuilderField) => void;
  onValues: (values: string[]) => void;
  onRemove: () => void;
}) {
  const spec = FIELD_SPECS[row.field];

  return (
    <s-stack gap={SPACE.item}>
      <FieldGrid>
        <s-select
          label={joined ? "And" : "Where"}
          disabled={disabled || undefined}
          onChange={(event) => onField(event.currentTarget.value as BuilderField)}
        >
          {BUILDER_FIELDS.map((field) => (
            <s-option key={field} value={field} defaultSelected={field === row.field}>
              {FIELD_SPECS[field].label}
            </s-option>
          ))}
        </s-select>
        {/* Keyed by field, so a row switched from "Tagged" to "Stock at least" gets a fresh
            control rather than one still holding the old row's text. */}
        <ValueControl key={row.field} row={row} facets={facets} disabled={disabled} onValues={onValues} />
        {row.values.length > 0 && spec.input.kind === "pick" ? (
          <FullRow>
            <s-stack direction="inline" gap={SPACE.tight}>
              {row.values.map((value) => (
                <s-clickable-chip
                  key={value}
                  removable
                  disabled={disabled || undefined}
                  accessibilityLabel={`${spec.label} ${value}`}
                  onRemove={() => onValues(row.values.filter((item) => item !== value))}
                >
                  {value}
                </s-clickable-chip>
              ))}
            </s-stack>
          </FullRow>
        ) : null}
      </FieldGrid>
      <ActionRow>
        <s-button variant="tertiary" icon="delete" disabled={disabled || undefined} onClick={onRemove}>
          Remove this condition
        </s-button>
      </ActionRow>
    </s-stack>
  );
}

/** The value half of a row, by the kind of value its field takes. */
function ValueControl({
  row,
  facets,
  disabled,
  onValues,
}: {
  row: RowState;
  facets: Facets;
  disabled: boolean;
  onValues: (values: string[]) => void;
}) {
  const spec = FIELD_SPECS[row.field];
  const off = disabled || undefined;

  switch (spec.input.kind) {
    case "pick": {
      const facet = spec.input.facet;
      const offered = facets[facet].filter((value) => !row.values.includes(value));
      return (
        <s-select
          label={row.values.length > 0 ? "Or also" : spec.label}
          disabled={off}
          details={[spec.details, facetDetails(facets.totals[facet], NOUNS[facet])].filter(Boolean).join(" ")}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (!value) return;
            onValues([...row.values, value]);
            // Back to the prompt, so the next value is picked from the same select.
            event.currentTarget.value = "";
          }}
        >
          <s-option value="" defaultSelected>
            {offered.length > 0 ? "Choose a value" : "Every value is chosen"}
          </s-option>
          {offered.map((value) => (
            <s-option key={value} value={value}>
              {value}
            </s-option>
          ))}
        </s-select>
      );
    }
    case "contains":
      return (
        <s-text-field
          label={spec.label}
          value={row.values[0] ?? ""}
          disabled={off}
          onInput={(event) => onValues([event.currentTarget.value])}
        />
      );
    case "whole":
      return (
        <s-number-field
          label={spec.label}
          value={row.values[0] ?? ""}
          disabled={off}
          details={spec.details}
          onInput={(event) => onValues([event.currentTarget.value])}
        />
      );
    case "status":
      return (
        <s-select label={spec.label} disabled={off} details={spec.details} onChange={(event) => onValues([event.currentTarget.value])}>
          <s-option value="" defaultSelected={!row.values[0]}>
            Choose a status
          </s-option>
          {STATUS_CHOICES.map((choice) => (
            <s-option key={choice.value} value={choice.value} defaultSelected={row.values[0] === choice.value}>
              {choice.label}
            </s-option>
          ))}
        </s-select>
      );
    case "yesNo":
      return (
        <s-select label={spec.label} disabled={off} details={spec.details} onChange={(event) => onValues([event.currentTarget.value])}>
          <s-option value="yes" defaultSelected={row.values[0] !== "no"}>
            {spec.input.yes}
          </s-option>
          <s-option value="no" defaultSelected={row.values[0] === "no"}>
            {spec.input.no}
          </s-option>
        </s-select>
      );
  }
}

const NOUNS: Record<keyof Facets["totals"], string> = {
  collections: "collections",
  tags: "tags",
  vendors: "vendors",
  productTypes: "product types",
};

/** One of the two picked lists: what it holds, by name, and the picker that adds to it. */
function PickedList({
  heading,
  about,
  gids,
  titles,
  disabled,
  pickLabel,
  onPick,
  onRemove,
}: {
  heading: string;
  /** What the list does, said whether or not it holds anything. */
  about: string;
  gids: readonly string[];
  titles: Record<string, string>;
  disabled: boolean;
  pickLabel: string;
  onPick: () => void;
  onRemove: (gid: string) => void;
}) {
  return (
    <s-stack gap={SPACE.item}>
      <s-text type="strong">{heading}</s-text>
      <Secondary>{about}</Secondary>
      {gids.length > 0 ? (
        <s-stack direction="inline" gap={SPACE.tight}>
          {gids.map((gid) => (
            <s-clickable-chip key={gid} removable disabled={disabled || undefined} onRemove={() => onRemove(gid)}>
              {titles[gid] ?? `Variant ${gid.split("/").pop()}`}
            </s-clickable-chip>
          ))}
        </s-stack>
      ) : null}
      <ActionRow>
        <s-button icon="product" disabled={disabled || undefined} onClick={onPick}>
          {pickLabel}
        </s-button>
      </ActionRow>
    </s-stack>
  );
}
