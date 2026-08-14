import type {
  FetchFunction,
  Provider,
} from "@earendil-works/pi-ai";

export const PROVIDER_PACKAGE_CONTRACT_VERSION = 1 as const;

export interface ProviderHostCapabilities {
  readonly fetch: FetchFunction;
  readonly now: () => number;
  readonly createUuid: () => string;
}

export interface ProviderPackageCreateInput {
  readonly configuration: unknown;
  readonly configurationPath: string;
  readonly host: ProviderHostCapabilities;
}

export interface LuckyTokenProviderPackage {
  readonly contractVersion: typeof PROVIDER_PACKAGE_CONTRACT_VERSION;
  createProvider(input: ProviderPackageCreateInput): Provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertLuckyTokenProviderPackage(
  value: unknown,
): LuckyTokenProviderPackage {
  if (!isRecord(value)) {
    throw new TypeError("providerPackage must be an object");
  }
  if (value.contractVersion !== PROVIDER_PACKAGE_CONTRACT_VERSION) {
    throw new TypeError(
      `providerPackage.contractVersion must be ${PROVIDER_PACKAGE_CONTRACT_VERSION}`,
    );
  }
  if (typeof value.createProvider !== "function") {
    throw new TypeError("providerPackage.createProvider must be a function");
  }
  return value as unknown as LuckyTokenProviderPackage;
}
