import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@token/application-control-plane/control-plane";

let nextId = 0;
const servers: RunningControlPlane[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

function endpoint(): ControlPlaneEndpoint {
  nextId += 1;
  return {
    address: `\\\\.\\pipe\\Token-provider-usage-${process.pid}-${nextId}`,
    capability: "provider-usage-capability-012345678901234567890123456789",
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Provider Usage Control Plane", () => {
  it("round-trips Profile-scoped query and refresh through Control Plane", async () => {
    const transport = createNodePipeTransport();
    const server = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "Token", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      providerUsageCommandHandler: async (command) => {
        if (command.command === "query") {
          return {
            outcome: "ok",
            snapshot: {
              profiles: [
                {
                  providerId: "openrouter",
                  credentialId: "profile-a",
                  state: "unobserved",
                },
              ],
            },
          };
        }
        return {
          outcome: "ok",
          snapshot: {
            profiles: [
              {
                providerId: command.providerId,
                credentialId: "profile-a",
                state: "observed",
                observedAt: 123,
                refreshable: true,
                windows: [{ kind: "weekly", usedPercent: 25 }],
                budgets: [],
              },
            ],
          },
          refresh: {
            providerId: command.providerId,
            credentialId: "profile-a",
            outcome: "succeeded",
          },
        };
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, {
      createRequestId: () => "request-" + String(++nextId),
      pipeConnector: transport,
    });
    clients.push(client);

    await expect(client.hello(controlPlaneVersion)).resolves.toMatchObject({
      type: "compatible",
      contractVersion: controlPlaneVersion,
    });

    await expect(
      client.executeProviderUsageCommand({ command: "query" }),
    ).resolves.toEqual({
      outcome: "ok",
      snapshot: {
        profiles: [
          {
            providerId: "openrouter",
            credentialId: "profile-a",
            state: "unobserved",
          },
        ],
      },
    });

    await expect(
      client.executeProviderUsageCommand({
        command: "refresh",
        providerId: "openrouter",
      }),
    ).resolves.toMatchObject({
      outcome: "ok",
      snapshot: {
        profiles: [
          {
            providerId: "openrouter",
            credentialId: "profile-a",
            state: "observed",
            windows: [{ kind: "weekly", usedPercent: 25 }],
          },
        ],
      },
      refresh: {
        providerId: "openrouter",
        credentialId: "profile-a",
        outcome: "succeeded",
      },
    });
  });

  it("keeps unrelated management commands responsive during a usage refresh", async () => {
    const transport = createNodePipeTransport();
    let entered!: () => void;
    const refreshEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "Token", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      applicationCommandHandler: async (command) =>
        command.command === "desktop_owner"
          ? { outcome: "lease_renewed" }
          : { outcome: "failed" },
      providerUsageCommandHandler: async (command) => {
        if (command.command === "refresh") {
          entered();
          await gate;
        }
        return {
          outcome: "ok",
          snapshot: {
            profiles: [
              {
                providerId: "openrouter",
                credentialId: "profile-a",
                state: "unobserved",
              },
            ],
          },
          ...(command.command === "refresh"
            ? {
                refresh: {
                  providerId: command.providerId,
                  credentialId: "profile-a",
                  outcome: "succeeded" as const,
                },
              }
            : {}),
        };
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, {
      createRequestId: () => "request-" + String(++nextId),
      pipeConnector: transport,
    });
    clients.push(client);
    await client.hello(controlPlaneVersion);

    const refresh = client.executeProviderUsageCommand({
      command: "refresh",
      providerId: "openrouter",
    });
    await refreshEntered;
    try {
      await expect(
        client.executeApplicationCommand({
          command: "desktop_owner",
          action: "renew",
          leaseId: "desktop-lease",
        }),
      ).resolves.toMatchObject({ outcome: "lease_renewed" });
    } finally {
      release();
      await refresh;
    }
  });
});
