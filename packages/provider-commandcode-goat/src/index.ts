import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  type TokenProviderPackage,
} from "@token/provider-contract/package";

import { createCommandCodeGoatProvider } from "./provider.js";

function assertEmptyConfiguration(value: unknown, path: string): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length > 0
  ) {
    throw new TypeError(`${path} must be an empty object`);
  }
}

export const providerPackage = Object.freeze({
  contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
  createProvider(input) {
    assertEmptyConfiguration(input.configuration, input.configurationPath);
    return createCommandCodeGoatProvider({ fetch: input.host.fetch });
  },
} satisfies TokenProviderPackage);
