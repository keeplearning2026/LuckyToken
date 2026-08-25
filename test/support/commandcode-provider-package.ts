import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  type TokenProviderPackage,
} from "@token/provider-contract/package";

import type { ImportProviderModule } from "../../src/providers/package-loader.js";
import { parseCommandCodeConfiguration } from "../../packages/provider-commandcode-private/src/configuration.js";
import { COMMANDCODE_MODELS } from "../../packages/provider-commandcode-private/src/models.js";
import { createCommandCodePrivateProvider } from "../../packages/provider-commandcode-private/src/provider.js";
import { providerPackage as commandCodeGoatProviderPackage } from "../../packages/provider-commandcode-goat/src/index.js";

export const COMMANDCODE_PROVIDER_PACKAGE =
  "@token/provider-commandcode-private";
export const COMMANDCODE_GOAT_PROVIDER_PACKAGE =
  "@token/provider-commandcode-goat";

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
  } satisfies TokenProviderPackage);
  return async (specifier) => {
    if (specifier === COMMANDCODE_PROVIDER_PACKAGE) {
      return Object.freeze({ providerPackage });
    }
    if (specifier === COMMANDCODE_GOAT_PROVIDER_PACKAGE) {
      return Object.freeze({ providerPackage: commandCodeGoatProviderPackage });
    }
    throw new Error(`Unexpected test Provider Package: ${specifier}`);
  };
}
