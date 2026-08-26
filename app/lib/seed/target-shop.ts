/**
 * Choosing which store a script writes to.
 *
 * The seeder used to take the first shop row it found. With one store installed that is
 * correct and invisible; with two it is a coin toss, and the losing side is a hundred
 * thousand products in somebody else's catalogue — which cannot be undone quickly and
 * makes every perf number taken afterwards meaningless.
 *
 * So: name the store, or be told which stores exist. Guessing is the one behaviour not
 * on offer.
 */

export interface ShopChoice {
  domain: string;
}

export class AmbiguousShopError extends Error {
  constructor(readonly available: readonly string[]) {
    super(
      `More than one store is installed, so there is no safe default. ` +
        `Pass --shop <domain>. Installed: ${available.join(", ")}`,
    );
    this.name = "AmbiguousShopError";
  }
}

export class UnknownShopError extends Error {
  constructor(readonly asked: string, readonly available: readonly string[]) {
    super(`No installed store matches "${asked}". Installed: ${available.join(", ")}`);
    this.name = "UnknownShopError";
  }
}

/** The `--shop` value, if the arguments carry one. */
export function shopArg(args: readonly string[]): string | undefined {
  const at = args.indexOf("--shop");
  return at === -1 ? undefined : args[at + 1];
}

/**
 * The store to write to.
 *
 * A prefix is accepted because `anchor-perf` is what a person types and
 * `anchor-perf.myshopify.com` is what the row holds — but only when it matches exactly
 * one store, so a prefix can never silently pick between two.
 */
export function chooseShop(
  installed: readonly ShopChoice[],
  asked: string | undefined,
): ShopChoice {
  const domains = installed.map((shop) => shop.domain);

  if (installed.length === 0) {
    throw new UnknownShopError(asked ?? "(none given)", domains);
  }

  if (!asked) {
    if (installed.length === 1) return installed[0]!;
    throw new AmbiguousShopError(domains);
  }

  const exact = installed.find((shop) => shop.domain === asked);
  if (exact) return exact;

  const prefixed = installed.filter((shop) => shop.domain.startsWith(`${asked}.`));
  if (prefixed.length === 1) return prefixed[0]!;

  throw new UnknownShopError(asked, domains);
}
