import {
  createCommandCodeModelCapabilities,
  loadCommandCodeModelCatalog,
  type CommandCodeModelCatalog,
  type CommandCodeModelCatalogLoadResult,
} from "@token/commandcode-model-catalog";

import type { ProviderNativeModelCapabilities } from "../provider-native-responses/contract.js";
import { bundledProviderPackages } from "./bundled.js";

/** The bundled Providers whose models the tracked CommandCode catalog defines. */
const COMMANDCODE_CATALOG_PROVIDER_IDS: ReadonlySet<string> = Object.freeze(
  new Set(
    bundledProviderPackages
      .map((entry) => entry.providerId)
      .filter(
        (providerId) =>
          providerId === "commandcode-private" ||
          providerId === "commandcode-goat",
      ),
  ),
);

function usesCommandCodeModelCatalog(providerId: string): boolean {
  return COMMANDCODE_CATALOG_PROVIDER_IDS.has(providerId);
}

function commandCodeEnvelope(
  catalog: CommandCodeModelCatalog,
  provider: unknown,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    catalog,
    provider,
  });
}

export function createBundledProviderConfigurations(
  commandCodeCatalog: CommandCodeModelCatalog,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      bundledProviderPackages.map((entry) => [
        entry.specifier,
        usesCommandCodeModelCatalog(entry.providerId)
          ? commandCodeEnvelope(commandCodeCatalog, entry.configuration)
          : entry.configuration,
      ]),
    ),
  );
}

/**
 * Token-owned Provider Native model capabilities, projected from the same
 * frozen catalog snapshot the bundled CommandCode Providers receive. The facts
 * stay outside the Pi `Model` and are answered by Provider/model identity.
 */
export function createBundledModelCapabilities(
  commandCodeCatalog: CommandCodeModelCatalog,
): ProviderNativeModelCapabilities {
  const capabilities = createCommandCodeModelCapabilities(commandCodeCatalog);
  return Object.freeze({
    responsesStreamOptions: (providerId: string, modelId: string) =>
      usesCommandCodeModelCatalog(providerId)
        ? capabilities.responsesStreamOptions(modelId)
        : undefined,
  });
}

export async function loadBundledProviderConfigurations(
  commandCodeModelsPath: string,
): Promise<{
  readonly configurations: Readonly<Record<string, unknown>>;
  readonly commandCodeCatalog: CommandCodeModelCatalogLoadResult;
  readonly modelCapabilities: ProviderNativeModelCapabilities;
}> {
  const commandCodeCatalog = await loadCommandCodeModelCatalog(
    commandCodeModelsPath,
  );
  return Object.freeze({
    configurations: createBundledProviderConfigurations(
      commandCodeCatalog.catalog,
    ),
    commandCodeCatalog,
    modelCapabilities: createBundledModelCapabilities(
      commandCodeCatalog.catalog,
    ),
  });
}
