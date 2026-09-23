import {
  loadCommandCodeModelCatalog,
  type CommandCodeModelCatalog,
  type CommandCodeModelCatalogLoadResult,
} from "@token/commandcode-model-catalog";

import { bundledProviderPackages } from "./bundled.js";

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
        entry.providerId === "commandcode-private" ||
        entry.providerId === "commandcode-goat"
          ? commandCodeEnvelope(commandCodeCatalog, entry.configuration)
          : entry.configuration,
      ]),
    ),
  );
}

export async function loadBundledProviderConfigurations(
  commandCodeModelsPath: string,
): Promise<{
  readonly configurations: Readonly<Record<string, unknown>>;
  readonly commandCodeCatalog: CommandCodeModelCatalogLoadResult;
}> {
  const commandCodeCatalog = await loadCommandCodeModelCatalog(
    commandCodeModelsPath,
  );
  return Object.freeze({
    configurations: createBundledProviderConfigurations(
      commandCodeCatalog.catalog,
    ),
    commandCodeCatalog,
  });
}
