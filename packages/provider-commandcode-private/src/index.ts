import {
  parseCommandCodeModelCatalog,
} from "@token/commandcode-model-catalog";
import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  type TokenProviderPackage,
} from "@token/provider-contract/package";

import { parseCommandCodeConfiguration } from "./configuration.js";
import { createCommandCodeModels } from "./models.js";
import { createCommandCodePrivateProvider } from "./provider.js";

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
  readonly provider: ReturnType<typeof parseCommandCodeConfiguration>;
} {
  const root = record(value, path);
  for (const key of Object.keys(root)) {
    if (key !== "catalog" && key !== "provider") {
      throw new Error(`${path}.${key} is unknown`);
    }
  }
  return Object.freeze({
    catalog: parseCommandCodeModelCatalog(root.catalog, `${path}.catalog`),
    provider: parseCommandCodeConfiguration(
      root.provider,
      `${path}.provider`,
    ),
  });
}

export const providerPackage = Object.freeze({
  contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
  createProvider(input) {
    const configuration = parsePackageConfiguration(
      input.configuration,
      input.configurationPath,
    );
    return createCommandCodePrivateProvider({
      configuration: configuration.provider,
      fetch: input.host.fetch,
      now: input.host.now,
      createSessionId: input.host.createUuid,
      models: createCommandCodeModels(configuration.catalog.models),
    });
  },
} satisfies TokenProviderPackage);
