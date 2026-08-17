import { describe, expect, it } from "vitest";

import { projectControlPlaneState } from "../src/control-plane-projection.js";

describe("Settings Developer Lab renderer projection", () => {
  it("projects the registered settings allowlist into the renderer state", () => {
    const projected = projectControlPlaneState({
      revision: 9,
      connection: "connected",
      applicationVersion: "1.2.3",
      contractVersion: 1,
      snapshot: {
        sequence: 3,
        modelDataPlane: "stopped",
        provider: "unconfigured",
        settings: {
          "protocols.anthropic-messages.enabled": {
            key: "protocols.anthropic-messages.enabled",
            type: "boolean",
            default: true,
            validation: { type: "boolean" },
            sensitivity: "public",
            applyMode: "hot-apply",
            value: false,
          },
          "protocols.openai-responses.enabled": {
            key: "protocols.openai-responses.enabled",
            type: "boolean",
            default: true,
            validation: { type: "boolean" },
            sensitivity: "public",
            applyMode: "hot-apply",
            value: true,
          },
          "diagnostics.deepCapture.enabled": {
            key: "diagnostics.deepCapture.enabled",
            type: "boolean",
            default: false,
            validation: { type: "boolean" },
            sensitivity: "public",
            applyMode: "hot-apply",
            value: true,
          },
          "server.port": {
            key: "server.port",
            type: "number",
            default: 3000,
            validation: { type: "integer", minimum: 1, maximum: 65_535 },
            sensitivity: "public",
            applyMode: "restart-required",
            value: 3210,
            effective: 3000,
          },
          "server.bindHost": {
            key: "server.bindHost",
            type: "string",
            default: "127.0.0.1",
            validation: { type: "host", label: "bind host" },
            sensitivity: "public",
            applyMode: "restart-required",
            value: "127.0.0.1",
            effective: "127.0.0.1",
          },
          "internal.env.FLAG": {
            key: "internal.env.FLAG",
            type: "string",
            default: "",
            validation: { type: "string" },
            sensitivity: "public",
            applyMode: "hot-apply",
            value: "must-not-leak",
          },
        },
      },
    });

    expect(projected).toMatchObject({
      kind: "connected",
      settings: {
        "protocols.anthropic-messages.enabled": { value: false },
        "diagnostics.deepCapture.enabled": { value: true },
        "server.port": { value: 3210, effective: 3000 },
      },
    });
    expect(
      (projected as { readonly settings?: Record<string, unknown> }).settings?.[
        "internal.env.FLAG"
      ],
    ).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("internal.env.FLAG");
    expect(JSON.stringify(projected)).not.toContain("must-not-leak");
  });
});
