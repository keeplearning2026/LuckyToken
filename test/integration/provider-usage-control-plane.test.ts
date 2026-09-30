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
  it("round-trips query and refresh through Control Plane v7", async () => {
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
      contractVersion: 7,
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

  it("keeps management commands responsive while a Provider Usage refresh is in flight", async () => {
    const transport = createNodePipeTransport();
    let refreshEnteredResolve!: () => void;
    const refreshEntered = new Promise<void>((resolve) => {
      refreshEnteredResolve = resolve;
    });
    let releaseRefreshResolve!: () => void;
    const releaseRefresh = new Promise<void>((resolve) => {
      releaseRefreshResolve = resolve;
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
      applicationCommandHandler: async (command) => {
        if (command.command === "desktop_owner") {
          return { outcome: "lease_renewed" };
        }
        return { outcome: "failed" };
      },
      providerUsageCommandHandler: async (command) => {
        if (command.command === "refresh") {
          refreshEnteredResolve();
          await releaseRefresh;
        }
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
          ...(command.command === "refresh"
            ? {
                refresh: {
                  providerId: command.providerId,
                  outcome: "succeeded" as const,
                },
              }
            : {}),
        };
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, {
      createRequestId: () => `request-${++nextId}`,
      pipeConnector: transport,
    });
    clients.push(client);
    await client.hello(controlPlaneVersion);

    const refresh = client.executeProviderUsageCommand({
      command: "refresh",
      providerId: "openrouter",
    });
    await refreshEntered;
    const renewal = client.executeApplicationCommand({
      command: "desktop_owner",
      action: "renew",
      leaseId: "desktop-lease",
    });
    try {
      await expect(Promise.race([
        renewal.then((result) => result.outcome),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("blocked"), 1_000);
        }),
      ])).resolves.toBe("lease_renewed");
    } finally {
      releaseRefreshResolve();
      await refresh;
    }
  });

  it("cancels and joins an in-flight Provider Usage refresh when the host closes", async () => {
    const transport = createNodePipeTransport();
    let refreshEnteredResolve!: () => void;
    const refreshEntered = new Promise<void>((resolve) => {
      refreshEnteredResolve = resolve;
    });
    let abortObservedResolve!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      abortObservedResolve = resolve;
    });
    let releaseAfterAbortResolve!: () => void;
    const releaseAfterAbort = new Promise<void>((resolve) => {
      releaseAfterAbortResolve = resolve;
    });
    let usageSignal: AbortSignal | undefined;
    let aborted = false;
    const server = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "Token", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      providerUsageCommandHandler: async (command, signal) => {
        if (command.command === "refresh") {
          usageSignal = signal;
          refreshEnteredResolve();
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
              aborted = true;
              resolve();
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          abortObservedResolve();
          await releaseAfterAbort;
        }
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
          ...(command.command === "refresh"
            ? {
                refresh: {
                  providerId: command.providerId,
                  outcome: "succeeded" as const,
                },
              }
            : {}),
        };
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, {
      createRequestId: () => `request-${++nextId}`,
      pipeConnector: transport,
    });
    clients.push(client);
    await client.hello(controlPlaneVersion);

    const refresh = client.executeProviderUsageCommand({
      command: "refresh",
      providerId: "openrouter",
    });
    const refreshSettled = refresh.catch(() => undefined);
    await refreshEntered;
    const closing = server.close();
    try {
      await abortObserved;
      expect(usageSignal?.aborted).toBe(true);
      expect(aborted).toBe(true);
      await expect(Promise.race([
        closing.then(() => "closed"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("pending"), 100);
        }),
      ])).resolves.toBe("pending");
      releaseAfterAbortResolve();
      await expect(closing).resolves.toBeUndefined();
    } finally {
      releaseAfterAbortResolve();
      await refreshSettled;
    }
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
