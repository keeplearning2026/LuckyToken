import type { ImportProviderModule } from "../../src/providers/package-loader.js";
import { providerPackage as deepSeekAnthropicProviderPackage } from "../../packages/provider-deepseek-anthropic/src/index.js";

export const DEEPSEEK_ANTHROPIC_PROVIDER_PACKAGE =
  "@token/provider-deepseek-anthropic";

/** Resolves only this Provider Package; composition lives in a neutral assembler. */
export function deepSeekAnthropicProviderImportModule(): ImportProviderModule {
  return async (specifier) => {
    if (specifier !== DEEPSEEK_ANTHROPIC_PROVIDER_PACKAGE) {
      throw new Error(`Unexpected test Provider Package: ${specifier}`);
    }
    return Object.freeze({
      providerPackage: deepSeekAnthropicProviderPackage,
    });
  };
}
