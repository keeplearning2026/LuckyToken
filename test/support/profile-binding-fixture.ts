import type {
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";
import type { AuthType } from "@earendil-works/pi-ai";

/** Test-only ambient binding seam for lane tests that do not exercise Profiles. */
export const ambientProfileBindings: Pick<
  ProviderAuthBindingAuthority,
  "capture" | "runBound" | "advanceAfterFinal429"
> = Object.freeze({
  async capture(providerId: string): Promise<ProviderAuthBindingCapture> {
    return Object.freeze({
      facts: Object.freeze({ kind: "ambient", providerId }),
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

/** Fixed managed binding for lane-owned wire certification tests. */
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
          kind: "managed" as const,
          providerId,
          credentialId,
        authType,
        authMethodLabel: authType === "api_key" ? "API key" : "Account",
        displayName: "Profile A",
          credentialGeneration: "credential-generation-a",
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
