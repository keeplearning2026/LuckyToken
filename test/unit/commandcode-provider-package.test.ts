import { providerPackage } from "@token/provider-commandcode-private";
import { DEFAULT_COMMANDCODE_MODEL_CATALOG } from "@token/commandcode-model-catalog";
import { describe, expect, it } from "vitest";

describe("CommandCode Provider Package", () => {
  it("creates the unchanged Pi Provider through the package contract", () => {
    const provider = providerPackage.createProvider({
      configuration: {
        catalog: DEFAULT_COMMANDCODE_MODEL_CATALOG,
        provider: {
          request: {
            transport: {
              timeoutMs: 1234,
              maxRetries: 2,
              maxRetryDelayMs: 5678,
            },
          },
        },
      },
      configurationPath:
        'providerPackages["@token/provider-commandcode-private"]',
      host: {
        fetch: async () => new Response(null, { status: 500 }),
        now: () => 1,
        createUuid: () => "00000000-0000-4000-8000-000000000001",
      },
    });

    expect(provider.id).toBe("commandcode-private");
    expect(provider.getModels().length).toBeGreaterThan(0);
  });

  it("keeps Provider-owned configuration distinct from the catalog envelope", () => {
    expect(() =>
      providerPackage.createProvider({
        configuration: {
          catalog: DEFAULT_COMMANDCODE_MODEL_CATALOG,
          provider: {
            request: {
              transport: { maxRetries: 101 },
            },
          },
        },
        configurationPath:
          'providerPackages["@token/provider-commandcode-private"]',
        host: {
          fetch: async () => new Response(null, { status: 500 }),
          now: () => 1,
          createUuid: () => "00000000-0000-4000-8000-000000000002",
        },
      }),
    ).toThrow(/maxRetries/u);
  });
});
