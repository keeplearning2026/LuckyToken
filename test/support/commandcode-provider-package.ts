import type { ImportProviderModule } from "../../src/providers/package-loader.js";
import { providerPackage as commandCodePrivateProviderPackage } from "../../packages/provider-commandcode-private/src/index.js";
import { providerPackage as commandCodeGoatProviderPackage } from "../../packages/provider-commandcode-goat/src/index.js";

export const COMMANDCODE_PROVIDER_PACKAGE =
  "@token/provider-commandcode-private";
export const COMMANDCODE_GOAT_PROVIDER_PACKAGE =
  "@token/provider-commandcode-goat";

export function commandCodeProviderImportModule(): ImportProviderModule {
  return async (specifier) => {
    if (specifier === COMMANDCODE_PROVIDER_PACKAGE) {
      return Object.freeze({
        providerPackage: commandCodePrivateProviderPackage,
      });
    }
    if (specifier === COMMANDCODE_GOAT_PROVIDER_PACKAGE) {
      return Object.freeze({
        providerPackage: commandCodeGoatProviderPackage,
      });
    }
    throw new Error(`Unexpected test Provider Package: ${specifier}`);
  };
}
