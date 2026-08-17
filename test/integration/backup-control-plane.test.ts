import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

let nextId = 0;
function endpoint(): ControlPlaneEndpoint {
  nextId += 1;
  return {
    pipeName: `\\\\.\\pipe\\luckytoken-t24-backup-${process.pid}-${nextId}`,
    capability: `ticket-24-backup-capability-${String(nextId).padStart(20, "0")}`,
  };
}

describe("Ticket 24 backup command through the Control Plane", () => {
  const hosts: RunningControlPlane[] = [];
  const transport = createNodePipeTransport();
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  it("strictly carries the ordinary and confirmed full-sensitive workflow", async () => {
    const target = endpoint();
    const seen: string[] = [];
    const host = await startControlPlane({
      endpoint: target,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      backupCommandHandler: async (command) => {
        seen.push(command.command);
        return command.command === "create"
          ? {
              outcome: "confirmation_required",
              actionId: "action-1",
              confirmationMessage: "Confirm full-sensitive backup.",
            }
          : {
              outcome: "ok",
              destinationPath: "C:\\exports\\backup.json",
              manifest: {
                format: "luckytoken-backup",
                formatVersion: 1,
                createdAt: 1,
                sensitive: true,
                entries: [
                  {
                    id: "provider-credentials",
                    contract: "pi-auth-json",
                    version: "0.84.1",
                    sensitive: true,
                  },
                ],
              },
            };
      },
    });
    hosts.push(host);
    const client = await connectControlPlane(target, {
      createRequestId: () => `request-${seen.length + 1}`,
      pipeConnector: transport,
    });
    await client.hello(1);
    await expect(
      client.executeBackup({
        mode: "full_sensitive",
        destinationPath: "C:\\exports\\backup.json",
        overwrite: false,
      }),
    ).resolves.toMatchObject({
      outcome: "confirmation_required",
      actionId: "action-1",
    });
    await expect(client.confirmBackup("action-1")).resolves.toMatchObject({
      outcome: "ok",
      manifest: { sensitive: true },
    });
    expect(seen).toEqual(["create", "confirm"]);
    await client.close();
  });

  it("projects exact incompatible file facts while the Data Plane stays stopped", async () => {
    const target = endpoint();
    const host = await startControlPlane({
      endpoint: target,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      recoveryProjection: () => ({
        mode: "incompatible_configuration",
        issues: [
          {
            path: "C:\\Users\\person\\.luckytoken\\state\\ledger.sqlite3",
            contract: "luckytoken-request-ledger",
            foundVersion: 1,
            expectedVersion: 2,
            validationError:
              "luckytoken-request-ledger version is incompatible with this LuckyToken build.",
          },
        ],
      }),
    });
    hosts.push(host);
    const client = await connectControlPlane(target, {
      createRequestId: () => "recovery-request",
      pipeConnector: transport,
    });
    await client.hello(1);
    const snapshot = await client.getStatus();
    expect(snapshot.modelDataPlane).toBe("stopped");
    expect(snapshot.recovery?.issues[0]).toEqual({
      path: "C:\\Users\\person\\.luckytoken\\state\\ledger.sqlite3",
      contract: "luckytoken-request-ledger",
      foundVersion: 1,
      expectedVersion: 2,
      validationError:
        "luckytoken-request-ledger version is incompatible with this LuckyToken build.",
    });
    await client.close();
  });
});
