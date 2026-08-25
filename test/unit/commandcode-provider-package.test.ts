import { providerPackage } from "@token/provider-commandcode-private";
import { describe, expect, it } from "vitest";

describe("CommandCode Provider Package", () => {
  it("creates the unchanged Pi Provider through the package contract", () => {
    const provider = providerPackage.createProvider({
      configuration: {},
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
});
