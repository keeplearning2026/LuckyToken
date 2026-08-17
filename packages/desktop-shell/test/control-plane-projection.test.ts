import { describe, expect, it } from "vitest";

import type { PersistenceProjection } from "@luckytoken/application-control-plane/control-plane";

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

describe("Audit-unavailable persistence projection (Ticket 23)", () => {
  function connected(persistence: PersistenceProjection | undefined) {
    return projectControlPlaneState({
      revision: 1,
      connection: "connected",
      applicationVersion: "0.0.0-test",
      contractVersion: 1,
      snapshot: {
        sequence: 1,
        modelDataPlane: "running",
        provider: "configured",
        ...(persistence === undefined ? {} : { persistence }),
      },
    });
  }

  it("projects the audit-unavailable state with authorities until acknowledged or recovered", () => {
    const projected = connected({
      auditUnavailable: true,
      acknowledged: false,
      authorities: [
        { authority: "requestLedger", since: 1_700_000_000_000 },
        { authority: "capture", since: 1_700_000_001_000 },
      ],
    });
    expect(projected.kind).toBe("connected");
    if (projected.kind !== "connected") return;
    expect(projected.persistence).toEqual({
      auditUnavailable: true,
      acknowledged: false,
      authorities: [
        { authority: "requestLedger", since: 1_700_000_000_000 },
        { authority: "capture", since: 1_700_000_001_000 },
      ],
    });
    // Acknowledged: the projection stays (it never claims recovery).
    const acknowledged = connected({
      auditUnavailable: true,
      acknowledged: true,
      authorities: [{ authority: "diagnostics", since: 1 }],
    });
    if (acknowledged.kind !== "connected") return;
    expect(acknowledged.persistence?.acknowledged).toBe(true);
    expect(acknowledged.persistence?.auditUnavailable).toBe(true);
    // Healthy snapshots carry no projection at all.
    const healthy = connected(undefined);
    if (healthy.kind !== "connected") return;
    expect(healthy.persistence).toBeUndefined();
  });

  it("drops a malformed persistence projection instead of projecting a lie", () => {
    // auditUnavailable false with authorities: not a real degraded state.
    const malformed = connected({
      auditUnavailable: false,
      acknowledged: false,
      authorities: [{ authority: "requestLedger", since: 1 }],
    } as unknown as PersistenceProjection);
    if (malformed.kind !== "connected") return;
    expect(malformed.persistence).toBeUndefined();
    // Unknown authority ids are rejected.
    const unknownAuthority = connected({
      auditUnavailable: true,
      acknowledged: false,
      authorities: [{ authority: "backup", since: 1 }],
    } as unknown as PersistenceProjection);
    if (unknownAuthority.kind !== "connected") return;
    expect(unknownAuthority.persistence).toBeUndefined();
  });
});

describe("Operational attention projection (Ticket 25)", () => {
  it("projects only fixed conditions and the aggregate count", () => {
    const projected = projectControlPlaneState({
      revision: 11,
      connection: "connected",
      applicationVersion: "test",
      contractVersion: 1,
      snapshot: {
        sequence: 20,
        modelDataPlane: "running",
        provider: "configured",
        attention: {
          conditions: [
            {
              id: "persistence-critical",
              category: "persistence-critical",
              since: 100,
              page: "diagnostics",
            },
          ],
          requestFailures: { count: 4, windowMs: 3_600_000 },
        },
      },
    });
    expect(projected).toMatchObject({
      kind: "connected",
      attention: {
        conditions: [{ category: "persistence-critical", page: "diagnostics" }],
        requestFailures: { count: 4, windowMs: 3_600_000 },
      },
    });
  });

  it("turns a secret-bearing attention extension into a protocol error", () => {
    const projected = projectControlPlaneState({
      revision: 12,
      connection: "connected",
      applicationVersion: "test",
      contractVersion: 1,
      snapshot: {
        sequence: 21,
        modelDataPlane: "running",
        provider: "configured",
        attention: {
          conditions: [],
          authorization: "Bearer attention-secret",
        },
      },
    } as unknown as ControlPlaneBridgePayload);
    expect(projected).toMatchObject({ kind: "error", code: "protocol_error" });
    expect(JSON.stringify(projected)).not.toContain("attention-secret");
  });
});
