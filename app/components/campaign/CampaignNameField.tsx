/**
 * The campaign's name, with a counter.
 *
 * Sami prefills `New task` and shows `8/100`; NA prefills a timestamped title and says
 * "This title is just for internal use, customers won't see it". Both are answering the
 * same two questions a merchant has about the first field on the page: does this matter,
 * and how much can I write. Ours prefilled and explained, and left the second unanswered.
 *
 * ## The counter is Polaris', not ours
 *
 * `maxLength` is all it takes: the field renders `17/100` at its trailing edge itself.
 * This component briefly kept its own count in React state and put it in the help text,
 * which rendered *both* — the same number twice, three centimetres apart, one of them
 * inside the box and one at the end of a sentence about storefront tags. It looked like a
 * bug because it was one. Only visible by opening the page: the markup serialises fine
 * and no test can see two counters and know they are the same counter.
 */

/**
 * Long enough for "Black Friday · outerwear · US and CA only", short enough that the
 * campaigns index does not become one column. Not a database constraint — `name` is
 * `String` — so this is a kindness rather than a rule.
 */
export const NAME_LIMIT = 100;

export function CampaignNameField({ defaultName }: { defaultName: string }) {
  return (
    <s-text-field
      name="name"
      label="Campaign name"
      value={defaultName}
      maxLength={NAME_LIMIT}
      details="For you and your team — customers never see it. Use the storefront tags below if you want your theme to badge the sale."
      required
    />
  );
}
