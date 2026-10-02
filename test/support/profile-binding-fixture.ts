import type { AuthType } from "@earendil-works/pi-ai";

import type {
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";

/** Test-only unbound seam for lane tests that do not exercise Token Profiles. */
export const ambientProfileBindings: Pick<
  ProviderAuthBindingAuthority,
  "capture" | "runBound" | "advanceAfterFinal429"
> = Object.freeze({
  async capture(providerId: string): Promise<ProviderAuthBindingCapture> {
    return Object.freeze({
      facts: Object.freeze({ kind: "unbound" as const, providerId }),
    });
  },
  runBound<T>(
    _capture: ProviderAuthBindingCapture,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  },
  async advanceAfterFinal429() {
    return Object.freeze({ outcome: "disabled" as const });
  },
});

/** Fixed exact Profile binding for lane-owned wire certification tests. */
export function fixedManagedProfileBindings(
  authType: AuthType,
  credentialId = "credential-a",
): Pick<
  ProviderAuthBindingAuthority,
  "capture" | "runBound" | "advanceAfterFinal429"
> {
  return Object.freeze({
    async capture(providerId: string): Promise<ProviderAuthBindingCapture> {
      return Object.freeze({
        facts: Object.freeze({
          kind: "profile" as const,
          providerId,
          credentialId,
          acquisitionKind:
            authType === "api_key" ? ("api_key" as const) : ("oauth" as const),
          authType,
          authMethodLabel: authType === "api_key" ? "API key" : "Account",
          displayName: "Profile A",
          referenceOwner: "managed" as const,
          selectionGeneration: "selection-generation-a",
        }),
      });
    },
    runBound<T>(
      _capture: ProviderAuthBindingCapture,
      operation: () => Promise<T>,
    ): Promise<T> {
      return operation();
    },
    async advanceAfterFinal429() {
      return Object.freeze({ outcome: "disabled" as const });
    },
  });
}
