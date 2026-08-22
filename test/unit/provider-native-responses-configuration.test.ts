import { describe, expect, it } from "vitest";

import {
  bindProviderNativeResponsesConfiguration,
  parseProviderNativeResponsesConfiguration,
} from "../../src/provider-native-responses/configuration.js";

describe("Provider Native Responses configuration", () => {
  it("owns an immutable default transport snapshot", () => {
    const configuration = parseProviderNativeResponsesConfiguration();

    expect(configuration).toEqual({
      transport: {
        maxRetries: 0,
        maxRetryDelayMs: 60_000,
      },
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.transport)).toBe(true);
    expect(bindProviderNativeResponsesConfiguration(configuration)).toBe(configuration);
  });

  it("accepts the documented boundaries including a disabled server-delay cap", () => {
    expect(
      parseProviderNativeResponsesConfiguration({
        transport: {
          maxRetries: 100,
          maxRetryDelayMs: 0,
        },
      }),
    ).toMatchObject({
      transport: {
        maxRetries: 100,
        maxRetryDelayMs: 0,
      },
    });
    expect(
      parseProviderNativeResponsesConfiguration({
        transport: { maxRetryDelayMs: 2_147_483_647 },
      }).transport.maxRetryDelayMs,
    ).toBe(2_147_483_647);
  });

  it.each([
    [null, "providerNative must be an object"],
    [{ extra: true }, "providerNative.extra is unknown"],
    [{ transport: [] }, "providerNative.transport must be an object"],
    [{ transport: { extra: true } }, "providerNative.transport.extra is unknown"],
    [{ transport: { maxRetries: -1 } }, "providerNative.transport.maxRetries"],
    [{ transport: { maxRetries: 101 } }, "providerNative.transport.maxRetries"],
    [{ transport: { maxRetries: 1.5 } }, "providerNative.transport.maxRetries"],
    [{ transport: { maxRetryDelayMs: -1 } }, "providerNative.transport.maxRetryDelayMs"],
    [
      { transport: { maxRetryDelayMs: 2_147_483_648 } },
      "providerNative.transport.maxRetryDelayMs",
    ],
  ])("rejects invalid input %#", (value, message) => {
    expect(() => parseProviderNativeResponsesConfiguration(value)).toThrow(message);
  });

  it("rejects configuration objects that were not parsed by this module", () => {
    expect(() =>
      bindProviderNativeResponsesConfiguration({
        transport: { maxRetries: 0, maxRetryDelayMs: 60_000 },
      }),
    ).toThrow("Provider Native Responses-owned snapshot");
  });
});
