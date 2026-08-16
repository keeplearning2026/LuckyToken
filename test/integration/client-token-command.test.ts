import { describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ClientTokenCommand,
  type ClientTokenCommandHandler,
  type ClientTokenCommandResult,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

/**
 * Ticket 16 seam: versioned Control Plane Client Token commands used by UI
 * and CLI. The host must serve list/reveal/rotate/remove with strict wire
 * decoding; the stub handler below is the test double at the public seam and
 * never stands in for the live authority (covered by HTTP slices).
 */
interface StubTokenCommandHandler extends ClientTokenCommandHandler {
  seedGlobal(token: string): void;
}

function stubTokenCommandHandler(): StubTokenCommandHandler {
  let revision = 0;
  let globalToken: string | undefined;
  const projectTokens = new Map<string, string>([
    ["C:\\projects\\legacy", "canary-project-token-77"],
  ]);
  const mask = (token: string): string => `${token.slice(0, 8)}…${token.slice(-4)}`;
  const scopes = () => [
    ...(globalToken === undefined
      ? []
      : [{ type: "global" as const, maskedToken: mask(globalToken as string) }]),
    ...[...projectTokens.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([projectDir, token]) => ({
        type: "project" as const,
        projectDir,
        maskedToken: mask(token),
      })),
  ];
  const handler = async (
    command: ClientTokenCommand,
  ): Promise<ClientTokenCommandResult> => {
    if (command.protocolId !== "anthropic-messages") {
      return {
        outcome: "unknown_protocol",
        revision,
        error: `Client Protocol is not installed: ${command.protocolId}`,
      };
    }
    if (command.command === "list") {
      return { outcome: "ok", revision, scopes: scopes() };
    }
    if (command.command === "reveal") {
      return globalToken === undefined
        ? {
            outcome: "not_found",
            revision,
            error: "Client token scope does not exist",
          }
        : { outcome: "ok", revision, token: globalToken };
    }
    if (command.expectedRevision !== revision) {
      return {
        outcome: "conflict",
        revision,
        error: "Client token revision is stale",
      };
    }
    if (command.command === "rotate") {
      if (globalToken === undefined) {
        return {
          outcome: "not_found",
          revision,
          error: "Client token scope does not exist",
        };
      }
      const replacement = command.token ?? `lt_generated_${revision + 1}`;
      if (
        replacement === globalToken ||
        [...projectTokens.values()].includes(replacement)
      ) {
        return {
          outcome: "invalid_value",
          revision,
          error: "Replacement client token is invalid",
        };
      }
      globalToken = replacement;
      revision += 1;
      return { outcome: "ok", revision, scopes: scopes() };
    }
    if (globalToken === undefined) {
      return {
        outcome: "not_found",
        revision,
        error: "Client token scope does not exist",
      };
    }
    globalToken = undefined;
    revision += 1;
    return { outcome: "ok", revision, scopes: scopes() };
  };
  return Object.assign(handler, {
    seedGlobal(token: string): void {
      globalToken = token;
      revision += 1;
    },
  });
}

describe("Control Plane Client Token commands", () => {
  const hosts: RunningControlPlane[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  async function startHost(handler: ClientTokenCommandHandler) {
    const endpoint: ControlPlaneEndpoint = {
      pipeName: `\\\\.\\pipe\\luckytoken-client-token-cmd-${process.pid}-${++nextPipe}`,
      capability: "client-token-command-capability-012345678901",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      clientTokenCommandHandler: handler,
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `client-token-command-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(1);
    return { host, client };
  }

  it("round-trips masked list and explicit reveal through the versioned wire", async () => {
    const handler = stubTokenCommandHandler();
    const { host, client } = await startHost(handler);

    const listed = await client.executeClientTokenCommand({
      command: "list",
      protocolId: "anthropic-messages",
    });
    expect(listed.outcome).toBe("ok");
    expect(listed.scopes).toEqual([
      {
        type: "project",
        projectDir: "C:\\projects\\legacy",
        maskedToken: "canary-p…n-77",
      },
    ]);

    const revealed = await client.executeClientTokenCommand({
      command: "reveal",
      protocolId: "anthropic-messages",
    });
    expect(revealed).toEqual({
      outcome: "not_found",
      revision: 0,
      error: "Client token scope does not exist",
    });

    // The wire must never deliver a raw secret through list results.
    expect(JSON.stringify(listed)).not.toContain("canary-project-token-77");
    expect(JSON.stringify(listed)).not.toContain("lt_");
    await client.close();
    await host.close();
  });

  it("rotates and removes with a locked revision and reports stale conflicts", async () => {
    const handler = stubTokenCommandHandler();
    handler.seedGlobal("canary-active-token-1");
    const { host, client } = await startHost(handler);

    const listed = await client.executeClientTokenCommand({
      command: "list",
      protocolId: "anthropic-messages",
    });
    expect(listed.outcome).toBe("ok");
    expect(listed.revision).toBe(1);

    // Rotate with the stale revision 0 must conflict and must not replace
    // the active token.
    const stale = await client.executeClientTokenCommand({
      command: "rotate",
      protocolId: "anthropic-messages",
      expectedRevision: 0,
      token: "canary-stale-token-1",
    });
    expect(stale).toEqual({
      outcome: "conflict",
      revision: 1,
      error: "Client token revision is stale",
    });

    const rotated = await client.executeClientTokenCommand({
      command: "rotate",
      protocolId: "anthropic-messages",
      expectedRevision: 1,
      token: "canary-rotated-token-2",
    });
    expect(rotated.outcome).toBe("ok");
    expect(rotated.revision).toBe(2);
    expect(rotated.scopes).toContainEqual({
      type: "global",
      maskedToken: "canary-r…en-2",
    });
    expect(JSON.stringify(rotated)).not.toContain("canary-rotated-token-2");

    const removed = await client.executeClientTokenCommand({
      command: "remove",
      protocolId: "anthropic-messages",
      expectedRevision: 2,
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.revision).toBe(3);
    expect(removed.scopes).toEqual([
      {
        type: "project",
        projectDir: "C:\\projects\\legacy",
        maskedToken: "canary-p…n-77",
      },
    ]);
    await client.close();
    await host.close();
  });

  it("rejects unknown protocols and malformed commands without leaking state", async () => {
    const handler = stubTokenCommandHandler();
    const { host, client } = await startHost(handler);

    await expect(
      client.executeClientTokenCommand({
        command: "list",
        protocolId: "not-installed",
      }),
    ).resolves.toEqual({
      outcome: "unknown_protocol",
      revision: 0,
      error: "Client Protocol is not installed: not-installed",
    });
    await expect(
      client.executeClientTokenCommand({
        command: "reveal",
        protocolId: "not-installed",
      }),
    ).resolves.toMatchObject({ outcome: "unknown_protocol" });
    await client.close();
    await host.close();
  });

  it("reports unavailable when no Client Token command handler is registered", async () => {
    const endpoint: ControlPlaneEndpoint = {
      pipeName: `\\\\.\\pipe\\luckytoken-client-token-cmd-${process.pid}-${++nextPipe}`,
      capability: "client-token-command-capability-012345678901",
    };
    const host = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: createNodePipeTransport(),
      access: nodePipeFallbackAccess,
    });
    hosts.push(host);
    const client = await connectControlPlane(host.endpoint, {
      createRequestId: () => `client-token-command-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(1);
    await expect(
      client.executeClientTokenCommand({
        command: "list",
        protocolId: "anthropic-messages",
      }),
    ).rejects.toThrow("unknown_command");
    await client.close();
    await host.close();
  });
});
