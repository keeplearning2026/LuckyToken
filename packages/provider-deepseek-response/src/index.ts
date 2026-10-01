import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  type ProviderPackageCreateInput,
  type TokenProviderPackage,
} from "@token/provider-contract/package";

import { createDeepSeekResponseProvider } from "./provider.js";

function parsePackageConfiguration(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    throw new Error(`${path}.${key} is unknown`);
  }
}

export const providerPackage = Object.freeze({
  contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
  createProvider(input: ProviderPackageCreateInput) {
    parsePackageConfiguration(input.configuration, input.configurationPath);
    return createDeepSeekResponseProvider({ fetch: input.host.fetch });
  },
}) satisfies TokenProviderPackage;
