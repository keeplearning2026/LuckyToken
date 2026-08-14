import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  type LuckyTokenProviderPackage,
} from "@luckytoken/provider-contract/package";

import { parseCommandCodeConfiguration } from "./configuration.js";
import { COMMANDCODE_MODELS } from "./models.js";
import { createNodeProjectSnapshot } from "./project.js";
import { createCommandCodePrivateProvider } from "./provider.js";

export { createCommandCodePrivateProvider } from "./provider.js";
export type {
  CommandCodeCompatibilityPolicy,
  CommandCodePrivateProviderOptions,
} from "./provider.js";
export type { ProjectSnapshot } from "./project.js";

export const providerPackage = Object.freeze({
  contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
  createProvider(input) {
    return createCommandCodePrivateProvider({
      configuration: parseCommandCodeConfiguration(
        input.configuration,
        input.configurationPath,
      ),
      fetch: input.host.fetch,
      now: input.host.now,
      projectSnapshot: createNodeProjectSnapshot(),
      createSessionId: input.host.createUuid,
      models: COMMANDCODE_MODELS,
    });
  },
} satisfies LuckyTokenProviderPackage);
