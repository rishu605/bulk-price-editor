/**
 * The campaign's name, with a counter.
 *
 * Sami prefills `New task` and shows `8/100`; NA prefills a timestamped title and says
 * "This title is just for internal use, customers won't see it". Both are answering the
 * same two questions a merchant has about the first field on the page: does this matter,
 * and how much can I write. Ours prefilled and explained, and left the second unanswered
 * — so a merchant typing a long, useful name had no idea whether it would be accepted
 * until they submitted.
 *
 * ## Why the counter is client state
 *
 * There is no server round trip that could produce it, and the alternative — a static
 * "maximum 100 characters" — tells somebody who is already over the limit nothing about
 * how far. The field stays uncontrolled: `value` seeds it and `onInput` only reads the
 * length, so React is never the authority on what is in the box. A controlled Polaris
 * field would need every keystroke to survive a re-render to keep the cursor where the
 * merchant left it.
 */

import { useState } from "react";

/**
 * Long enough for "Black Friday · outerwear · US and CA only", short enough that the
 * campaigns index does not become one column. Not a database constraint — `name` is
 * `String` — so this is a kindness, not a rule, and the counter says so by counting up
 * rather than warning.
 */
export const NAME_LIMIT = 100;

export function CampaignNameField({ defaultName }: { defaultName: string }) {
  const [length, setLength] = useState(defaultName.length);

  return (
    <s-text-field
      name="name"
      label="Campaign name"
      value={defaultName}
      maxLength={NAME_LIMIT}
      onInput={(event) => setLength((event.target as HTMLInputElement).value.length)}
      details={`For you and your team — customers never see it. Use the storefront tags below if you want your theme to badge the sale. ${length}/${NAME_LIMIT}`}
      required
    />
  );
}
