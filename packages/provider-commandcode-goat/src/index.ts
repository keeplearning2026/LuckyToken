import {
  parseCommandCodeModelCatalog,
} from "@token/commandcode-model-catalog";
import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  type TokenProviderPackage,
} from "@token/provider-contract/package";

import { createCommandCodeGoatModels } from "./models.js";
import { createCommandCodeGoatProvider } from "./provider.js";

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parsePackageConfiguration(
  value: unknown,
  path: string,
): {
  readonly catalog: ReturnType<typeof parseCommandCodeModelCatalog>;
} {
  const root = record(value, path);
  for (const key of Object.keys(root)) {
    if (key !== "catalog" && key !== "provider") {
      throw new Error(`${path}.${key} is unknown`);
    }
  }
  const provider = record(root.provider ?? {}, `${path}.provider`);
  if (Object.keys(provider).length !== 0) {
    throw new Error(`${path}.provider must be empty`);
  }
  return Object.freeze({
    catalog: parseCommandCodeModelCatalog(root.catalog, `${path}.catalog`),
  });
}

export const providerPackage = Object.freeze({
  contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
  createProvider(input) {
    const configuration = parsePackageConfiguration(
      input.configuration,
      input.configurationPath,
    );
    return createCommandCodeGoatProvider({
      fetch: input.host.fetch,
      models: createCommandCodeGoatModels(configuration.catalog.models),
    });
  },
} satisfies TokenProviderPackage);
