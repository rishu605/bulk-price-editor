import { formatCount } from "../lib/format/display";

/** A row of labelled figures, used for preview and catalogue summaries. */
export function CountsRow({ items }: { items: Array<{ label: string; value: number }> }) {
  return (
    <s-stack direction="inline" gap="large">
      {items.map((item) => (
        <s-box key={item.label}>
          <s-text>{item.label}</s-text>
          <s-heading>{formatCount(item.value)}</s-heading>
        </s-box>
      ))}
    </s-stack>
  );
}
