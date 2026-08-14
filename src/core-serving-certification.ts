export interface CoreServingCertificationManifest {
  readonly schemaVersion: "luckytoken-core-serving-certification-v1";
  readonly result: "CERTIFIED";
  readonly clientProtocolIds: readonly string[];
  readonly providerIds: readonly string[];
  readonly providerRegistrationPolicy:
    "pi-builtins-models-json-provider-packages-v1";
  readonly limits: {
    readonly maxRequestBytes: number;
    readonly requestTimeoutMs: number;
  };
}

export interface CoreServingCertificationFacts {
  readonly clientProtocolIds: readonly string[];
  readonly providerIds: readonly string[];
  readonly maxRequestBytes: number;
  readonly requestTimeoutMs: number;
}

export function certifyCoreServingComposition(
  facts: CoreServingCertificationFacts,
): CoreServingCertificationManifest {
  if (facts.clientProtocolIds.length === 0) {
    throw new Error("Core certification requires a Client Protocol");
  }
  if (!Number.isSafeInteger(facts.maxRequestBytes) || facts.maxRequestBytes < 1) {
    throw new Error("Core certification maxRequestBytes must be positive");
  }
  if (!Number.isSafeInteger(facts.requestTimeoutMs) || facts.requestTimeoutMs < 1) {
    throw new Error("Core certification requestTimeoutMs must be positive");
  }
  return Object.freeze({
    schemaVersion: "luckytoken-core-serving-certification-v1",
    result: "CERTIFIED",
    clientProtocolIds: Object.freeze([...facts.clientProtocolIds]),
    providerIds: Object.freeze([...facts.providerIds]),
    providerRegistrationPolicy:
      "pi-builtins-models-json-provider-packages-v1",
    limits: Object.freeze({
      maxRequestBytes: facts.maxRequestBytes,
      requestTimeoutMs: facts.requestTimeoutMs,
    }),
  });
}
