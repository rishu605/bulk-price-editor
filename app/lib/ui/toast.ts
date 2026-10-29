/**
 * The admin's toast, when App Bridge is there to show it. It is not during a render test.
 *
 * Where a result is said when the merchant may be looking anywhere on the page. A banner
 * sits where it was rendered; on Settings that is the top of a long page, and the merchant
 * who saved from the save bar while reading the last card never saw it (#1119).
 */
export function showToast(message: string, isError = false): void {
  if (typeof shopify === "undefined") return;
  shopify.toast.show(message, { isError });
}
