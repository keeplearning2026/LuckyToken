import { describe, expect, it } from "vitest";

import {
  projectControlPlaneState,
  type ControlPlaneBridgePayload,
} from "../src/control-plane-projection.js";

describe("Control Plane renderer projection public seam", () => {
  it("projects only the compatible identity and Ticket01 status snapshot", () => {
    const projected = projectControlPlaneState({
      revision: 4,
      connection: "connected",
      applicationVersion: "1.2.3",
      contractVersion: 1,
      snapshot: {
        sequence: 12,
        modelDataPlane: "running",
        provider: "unconfigured",
        capability: "must-not-reach-renderer",
        clientToken: "also-must-not-reach-renderer",
      },
      mutableInternalState: { connected: true },
    });

    expect(projected).toEqual({
      revision: 4,
      kind: "connected",
      applicationVersion: "1.2.3",
      contractVersion: 1,
      sequence: 12,
      modelDataPlane: "running",
      provider: "unconfigured",
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /capability|clientToken|mutableInternalState|must-not-reach-renderer/u,
    );
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it.each([
    {
      payload: {
        revision: 5,
        connection: "version_mismatch" as const,
        requestedVersion: 1,
        supportedVersions: [2],
        capability: "version-secret",
      },
      expected: {
        revision: 5,
        kind: "error",
        code: "version_mismatch",
        title: "Desktop update required",
        detail:
          "This desktop supports Control Plane v1; the active backend supports v2.",
        action: "Install matching LuckyToken desktop and backend versions.",
      },
    },
    {
      payload: {
        revision: 6,
        connection: "unavailable" as const,
        reason: "descriptor_missing" as const,
        capability: "discovery-secret",
      },
      expected: {
        revision: 6,
        kind: "error",
        code: "descriptor_missing",
        title: "LuckyToken backend is not available",
        detail: "No active local Control Plane was found.",
        action: "Start LuckyToken, then reconnect.",
      },
    },
    {
      payload: {
        revision: 7,
        connection: "disconnected" as const,
        reason: "transport_lost" as const,
        capability: "transport-secret",
      },
      expected: {
        revision: 7,
        kind: "error",
        code: "transport_lost",
        title: "Connection to LuckyToken was lost",
        detail: "The active local Control Plane disconnected.",
        action: "Restart LuckyToken, then reconnect.",
      },
    },
  ])("projects $payload.connection as actionable state", ({ payload, expected }) => {
    const projected = projectControlPlaneState(payload);

    expect(projected).toEqual(expected);
    expect(JSON.stringify(projected)).not.toMatch(/capability|secret/u);
  });

  it("projects the headless owner identity without forwarding transport details", () => {
    const projected = projectControlPlaneState({
      revision: 9,
      connection: "connected",
      applicationVersion: "1.2.3",
      contractVersion: 1,
      snapshot: {
        sequence: 15,
        modelDataPlane: "running",
        provider: "configured",
        ownership: {
          owner: {
            kind: "cli",
            pid: 4242,
            startedAt: "2026-08-15T12:00:00.000Z",
          },
        },
        capability: "must-not-reach-renderer",
      },
    });

    expect(projected).toMatchObject({
      kind: "connected",
      ownership: {
        owner: {
          kind: "cli",
          pid: 4242,
          startedAt: "2026-08-15T12:00:00.000Z",
        },
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /capability|must-not-reach-renderer/u,
    );
  });

  it("rejects a connected snapshot whose owner identity is malformed", () => {
    const projected = projectControlPlaneState({
      revision: 10,
      connection: "connected",
      applicationVersion: "1.2.3",
      contractVersion: 1,
      snapshot: {
        sequence: 16,
        modelDataPlane: "running",
        provider: "configured",
        ownership: {
          owner: { kind: "unknown-owner-kind", pid: -1, startedAt: "nope" },
        },
      },
    } as unknown as ControlPlaneBridgePayload);

    expect(projected).toMatchObject({
      kind: "error",
      code: "protocol_error",
    });
  });

  it("projects a failed fixed-port lifecycle without forwarding raw failure text", () => {
    const projected = projectControlPlaneState({
      revision: 8,
      connection: "connected",
      applicationVersion: "1.2.3",
      contractVersion: 1,
      snapshot: {
        sequence: 14,
        modelDataPlane: "failed",
        provider: "unconfigured",
        dataPlane: {
          configuredOrigin: "http://127.0.0.1:3000",
          configuredPort: 3000,
          failure: {
            code: "port_in_use",
            message: "raw renderer secret",
          },
        },
      },
    });

    expect(projected).toMatchObject({
      kind: "connected",
      modelDataPlane: "failed",
      dataPlane: {
        configuredPort: 3000,
        failure: {
          code: "port_in_use",
          message:
            "The configured port is already in use. Stop the other application or choose a different port.",
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("raw renderer secret");
  });
});
