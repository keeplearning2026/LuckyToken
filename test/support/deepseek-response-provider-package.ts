import type { ImportProviderModule } from "../../src/providers/package-loader.js";
import { providerPackage as deepSeekResponseProviderPackage } from "../../packages/provider-deepseek-response/src/index.js";

export const DEEPSEEK_RESPONSE_PROVIDER_PACKAGE =
  "@token/provider-deepseek-response";

/** Resolves only this Provider Package; composition lives in a neutral assembler. */
export function deepSeekResponseProviderImportModule(): ImportProviderModule {
  return async (specifier) => {
    if (specifier !== DEEPSEEK_RESPONSE_PROVIDER_PACKAGE) {
      throw new Error(`Unexpected test Provider Package: ${specifier}`);
    }
    return Object.freeze({
      providerPackage: deepSeekResponseProviderPackage,
    });
  };
}
