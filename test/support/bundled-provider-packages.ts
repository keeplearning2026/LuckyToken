import { bundledProviderPackages } from "../../src/providers/bundled.js";
import type { ImportProviderModule } from "../../src/providers/package-loader.js";
import {
  COMMANDCODE_GOAT_PROVIDER_PACKAGE,
  COMMANDCODE_PROVIDER_PACKAGE,
  commandCodeProviderImportModule,
} from "./commandcode-provider-package.js";
import {
  DEEPSEEK_RESPONSE_PROVIDER_PACKAGE,
  deepSeekResponseProviderImportModule,
} from "./deepseek-response-provider-package.js";

/**
 * Neutral test assembler: every bundled Provider Package keeps its own
 * import fragment, and runtime tests resolve the product assembly through
 * this single function. The assembler fails loudly when a bundled Provider
 * is added without its own fragment.
 */
export function bundledProviderImportModule(): ImportProviderModule {
  const commandCode = commandCodeProviderImportModule();
  const deepSeekResponse = deepSeekResponseProviderImportModule();
  const fragments: Readonly<Record<string, ImportProviderModule>> =
    Object.freeze({
      [COMMANDCODE_PROVIDER_PACKAGE]: commandCode,
      [COMMANDCODE_GOAT_PROVIDER_PACKAGE]: commandCode,
      [DEEPSEEK_RESPONSE_PROVIDER_PACKAGE]: deepSeekResponse,
    });
  for (const entry of bundledProviderPackages) {
    if (fragments[entry.specifier] === undefined) {
      throw new Error(
        `Missing test import fragment for bundled Provider Package: ${entry.specifier}`,
      );
    }
  }
  return async (specifier) => {
    const fragment = fragments[specifier];
    if (fragment === undefined) {
      throw new Error(`Unexpected test Provider Package: ${specifier}`);
    }
    return fragment(specifier);
  };
}
