import { describe, expect, it } from "vitest";

import {
  decodeAuthCommandResult,
  decodeAuthOptionsProjection,
} from "@luckytoken/application-control-plane/control-plane";

/**
 * Provider Activation Spec §23.5 CP1/CP2: Provider source projection is a
 * strict Control Plane wire fact. All three source values round-trip;
 * missing/unknown values fail closed.
 */
describe("Auth Provider source wire contract", () => {
  function option(source: string): unknown {
    return {
      providerId: "p1",
      name: "Provider One",
      source,
      account: true,
      subscription: false,
      apiKey: true,
      status: {
        providerId: "p1",
        stored: false,
        environment: false,
        modelsJson: false,
        commandDerived: false,
        expired: false,
        unavailable: true,
        effectiveSource: "none",
      },
    };
  }

  it("round-trips all three Provider source values", () => {
    for (const source of ["pi_builtin", "luckytoken_bundled", "user"]) {
      const decoded = decodeAuthOptionsProjection({
        providers: [option(source)],
      });
      expect(decoded?.providers[0]?.source).toBe(source);
    }
  });

  it("fails closed on a missing or unknown source value", () => {
    const raw = option("pi_builtin") as Record<string, unknown>;
    const missing: Record<string, unknown> = { ...raw };
    delete missing.source;
    expect(decodeAuthOptionsProjection({ providers: [missing] })).toBeUndefined();
    expect(
      decodeAuthOptionsProjection({ providers: [option("custom_source")] }),
    ).toBeUndefined();
    expect(
      decodeAuthOptionsProjection({ providers: [option("")] }),
    ).toBeUndefined();
  });

  it("an auth command result with an invalid source never decodes", () => {
    const result = decodeAuthCommandResult(
      {
        outcome: "ok",
        state: {
          revision: 0,
          path: "/tmp/auth.json",
          present: false,
          valid: false,
          providers: [],
        },
        options: { providers: [option("unknown")] },
      },
      { command: "query" },
    );
    expect(result).toBeUndefined();
  });
});
