import {
  PROVIDER_PACKAGE_CONTRACT_VERSION,
  assertLuckyTokenProviderPackage,
} from "@luckytoken/provider-contract/package";
import { describe, expect, it } from "vitest";

describe("Provider Package contract", () => {
  it("accepts the fixed providerPackage export shape", () => {
    const providerPackage = Object.freeze({
      contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
      createProvider: () => {
        throw new Error("not invoked by contract validation");
      },
    });

    expect(assertLuckyTokenProviderPackage(providerPackage)).toBe(providerPackage);
  });
});
