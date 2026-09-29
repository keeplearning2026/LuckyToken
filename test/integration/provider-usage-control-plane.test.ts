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
  it("round-trips query and refresh through Control Plane v6", async () => {
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
              providers: [
                {
                  providerId: "openrouter",
                  state: "unobserved",
                },
              ],
            },
          };
        }
        return {
          outcome: "ok",
          snapshot: {
            providers: [
              {
                providerId: command.providerId,
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
            outcome: "succeeded",
          },
        };
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, {
      createRequestId: () => `request-${++nextId}`,
      pipeConnector: transport,
    });
    clients.push(client);
    await expect(client.hello(controlPlaneVersion)).resolves.toMatchObject({
      type: "compatible",
      contractVersion: 6,
    });

    await expect(
      client.executeProviderUsageCommand({ command: "query" }),
    ).resolves.toEqual({
      outcome: "ok",
      snapshot: {
        providers: [
          {
            providerId: "openrouter",
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
    ).resolves.toEqual({
      outcome: "ok",
      snapshot: {
        providers: [
          {
            providerId: "openrouter",
            state: "observed",
            observedAt: 123,
            refreshable: true,
            windows: [{ kind: "weekly", usedPercent: 25 }],
            budgets: [],
          },
        ],
      },
      refresh: {
        providerId: "openrouter",
        outcome: "succeeded",
      },
    });
  });

  it("returns a Control Plane error when the Provider Usage handler throws", async () => {
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
      providerUsageCommandHandler: async () => {
        throw new Error("unexpected authority failure");
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, {
      createRequestId: () => `request-${++nextId}`,
      pipeConnector: transport,
    });
    clients.push(client);
    await client.hello(controlPlaneVersion);

    await expect(
      client.executeProviderUsageCommand({
        command: "refresh",
        providerId: "openrouter",
      }),
    ).rejects.toThrow();
  });

  it("fails closed when the host emits malformed Provider Usage data", async () => {
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
      providerUsageCommandHandler: async () =>
        ({
          outcome: "ok",
          snapshot: {
            providers: [
              {
                providerId: "openrouter",
                state: "observed",
                observedAt: 1,
                refreshable: true,
                windows: [{ kind: "weekly", usedPercent: 500 }],
                budgets: [],
              },
            ],
          },
        }) as never,
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, {
      createRequestId: () => `request-${++nextId}`,
      pipeConnector: transport,
    });
    clients.push(client);
    await client.hello(controlPlaneVersion);

    await expect(
      client.executeProviderUsageCommand({ command: "query" }),
    ).rejects.toThrow();
  });
});
