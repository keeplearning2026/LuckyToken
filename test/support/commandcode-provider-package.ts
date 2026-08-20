import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  type LuckyTokenProviderPackage,
} from "@luckytoken/provider-contract/package";

import type { ImportProviderModule } from "../../src/providers/package-loader.js";
import { parseCommandCodeConfiguration } from "../../packages/provider-commandcode-private/src/configuration.js";
import { COMMANDCODE_MODELS } from "../../packages/provider-commandcode-private/src/models.js";
import { createCommandCodePrivateProvider } from "../../packages/provider-commandcode-private/src/provider.js";

export const COMMANDCODE_PROVIDER_PACKAGE =
  "@luckytoken/provider-commandcode-private";

export function commandCodeProviderImportModule(): ImportProviderModule {
  const providerPackage = Object.freeze({
    contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
    createProvider(input) {
      return createCommandCodePrivateProvider({
        configuration: parseCommandCodeConfiguration(
          input.configuration,
          input.configurationPath,
        ),
        fetch: input.host.fetch,
        now: input.host.now,
        createSessionId: input.host.createUuid,
        models: COMMANDCODE_MODELS,
      });
    },
  } satisfies LuckyTokenProviderPackage);
  return async (specifier) => {
    if (specifier !== COMMANDCODE_PROVIDER_PACKAGE) {
      throw new Error(`Unexpected test Provider Package: ${specifier}`);
    }
    return Object.freeze({ providerPackage });
  };
}
