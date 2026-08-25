/**
 * Token bundled Provider Package metadata (Provider Activation
 * Specification v1.0 §8.2).
 *
 * This module owns only immutable product assembly facts: which Provider
 * Packages Token ships as part of the product, their reserved npm
 * specifiers, their reserved Provider IDs, and their fixed configuration.
 * It is NOT a Provider catalog — names, auth labels, models and behavior
 * still come from the Provider returned by the loaded package.
 *
 * The metadata exists to:
 *
 * - load the package automatically on Backend start (no user config);
 * - reserve the package specifier so user configuration cannot claim it;
 * - reserve the Provider ID so user models.json/package configuration
 *   cannot shadow it;
 * - classify the Provider's product source (`token_bundled`);
 * - certify the release assembly resolves and registers it.
 */

export interface BundledProviderPackage {
  readonly specifier: string;
  readonly providerId: string;
  readonly configuration: unknown;
}

/**
 * The frozen product assembly list. Each bundled Provider has its own package
 * specifier/id; the loading and classification machinery is generic.
 */
export const bundledProviderPackages: readonly BundledProviderPackage[] =
  Object.freeze([
    Object.freeze({
      specifier: "@token/provider-commandcode-private",
      providerId: "commandcode-private",
      configuration: Object.freeze({}),
    }),
    Object.freeze({
      specifier: "@token/provider-commandcode-goat",
      providerId: "commandcode-goat",
      configuration: Object.freeze({}),
    }),
  ]);

/** The bundled package specifiers, as a set for cheap membership checks. */
export const bundledProviderSpecifiers: ReadonlySet<string> = Object.freeze(
  new Set(bundledProviderPackages.map((entry) => entry.specifier)),
);

/** The bundled Provider IDs, as a set for cheap membership checks. */
export const bundledProviderIds: ReadonlySet<string> = Object.freeze(
  new Set(bundledProviderPackages.map((entry) => entry.providerId)),
);

/** Find the bundled package metadata for one Provider ID, if any. */
export function bundledPackageForProviderId(
  providerId: string,
): BundledProviderPackage | undefined {
  return bundledProviderPackages.find((entry) => entry.providerId === providerId);
}

/** Find the bundled package metadata for one specifier, if any. */
export function bundledPackageForSpecifier(
  specifier: string,
): BundledProviderPackage | undefined {
  return bundledProviderPackages.find((entry) => entry.specifier === specifier);
}
