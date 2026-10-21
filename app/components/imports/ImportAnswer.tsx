/**
 * The price import's one-sentence answer, as a banner (#798).
 *
 * `/app/price-import` answers every check with a sentence — "118 of 120 rows matched a
 * product. Nothing has been created yet." — and a refused commit with the reason. The
 * campaign editor kept the sentence only for a refusal, so a check that passed produced a
 * report card below the import history table and nothing else: nothing a screen reader
 * would announce, and nothing a sighted merchant would see without scrolling past a table.
 *
 * A banner, as the baseline and cost imports give theirs (#1059). Polaris renders one with
 * a status role — an alert for a critical one — so the answer is said as well as shown.
 */
export function ImportAnswer({
  answer,
}: {
  answer: { ok?: boolean; message?: string } | undefined;
}) {
  if (!answer?.message) return null;

  return (
    <s-banner tone={answer.ok === false ? "critical" : "success"}>
      <s-paragraph>{answer.message}</s-paragraph>
    </s-banner>
  );
}
