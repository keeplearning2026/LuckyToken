import { afterEach, describe, expect, it } from "vitest";

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
    if (
      command.command !== "rotate" && command.command !== "remove"
    ) {
      throw new Error("unreachable");
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

/**
 * Ticket 17 directory scopes: the same versioned wire carries an optional
 * scope reference on reveal/rotate/remove and a new create command; the
 * backend canonicalizes the raw input path. This suite proves the wire
 * round-trip; canonicalization acceptance lives in the HTTP/CLI suites.
 */
function directoryStubTokenCommandHandler(): StubTokenCommandHandler {
  let revision = 0;
  let globalToken: string | undefined;
  const projectTokens = new Map<string, string>();
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
  const resolveDir = (inputDir: string): string | undefined => {
    // Wire double: "reject:" inputs stand in for backend canonicalization
    // failures; everything else is treated as already canonical.
    return inputDir.startsWith("reject:") ? undefined : inputDir;
  };
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
    if (command.command === "create") {
      if (command.scope.type === "global") {
        if (globalToken !== undefined) {
          return { outcome: "already_exists", revision, error: "Client token scope already has a token" };
        }
        globalToken = command.token ?? `lt_generated_${revision + 1}`;
        revision += 1;
        return { outcome: "ok", revision, scopes: scopes() };
      }
      const canonicalDir = resolveDir(command.scope.projectDir);
      if (canonicalDir === undefined) {
        return {
          outcome: "invalid_directory",
          revision,
          reason: command.scope.projectDir.startsWith("reject:not_found:")
            ? "not_found"
            : "not_a_directory",
          error: "Selected directory is not usable as a client token scope",
        };
      }
      if (projectTokens.has(canonicalDir)) {
        return {
          outcome: "already_exists",
          revision,
          error: "Client token scope already has a token",
        };
      }
      projectTokens.set(canonicalDir, command.token ?? `lt_generated_${revision + 1}`);
      revision += 1;
      return { outcome: "ok", revision, scopes: scopes() };
    }
    if (command.command === "reveal") {
      if (command.scope?.type === "project") {
        const canonicalDir = resolveDir(command.scope.projectDir);
        const token = canonicalDir === undefined ? undefined : projectTokens.get(canonicalDir);
        return token === undefined
          ? { outcome: "not_found", revision, error: "Client token scope does not exist" }
          : { outcome: "ok", revision, token };
      }
      return globalToken === undefined
        ? { outcome: "not_found", revision, error: "Client token scope does not exist" }
        : { outcome: "ok", revision, token: globalToken };
    }
    if (command.expectedRevision !== revision) {
      return { outcome: "conflict", revision, error: "Client token revision is stale" };
    }
    const scopeToken = () => {
      if (command.command === "remove" || command.command === "rotate") {
        if (command.scope?.type === "project") {
          const canonicalDir = resolveDir(command.scope.projectDir);
          return { canonicalDir, current: canonicalDir === undefined ? undefined : projectTokens.get(canonicalDir) };
        }
        return { canonicalDir: undefined, current: globalToken };
      }
      return { canonicalDir: undefined, current: undefined };
    };
    const { canonicalDir, current } = scopeToken();
    if (current === undefined) {
      return { outcome: "not_found", revision, error: "Client token scope does not exist" };
    }
    if (command.command === "rotate") {
      const replacement = command.token ?? `lt_generated_${revision + 1}`;
      if (replacement === current) {
        return { outcome: "invalid_value", revision, error: "Replacement client token is invalid" };
      }
      if (canonicalDir === undefined) {
        globalToken = replacement;
      } else {
        projectTokens.set(canonicalDir, replacement);
      }
      revision += 1;
      return { outcome: "ok", revision, scopes: scopes() };
    }
    if (canonicalDir === undefined) {
      globalToken = undefined;
    } else {
      projectTokens.delete(canonicalDir);
    }
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

describe("Control Plane directory-scoped Client Token commands (Ticket 17)", () => {
  const hosts: RunningControlPlane[] = [];
  let nextPipe = 0;
  let nextRequest = 0;

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  async function startHost(handler: ClientTokenCommandHandler) {
    const endpoint: ControlPlaneEndpoint = {
      pipeName: `\\\\.\\pipe\\luckytoken-dir-token-cmd-${process.pid}-${++nextPipe}`,
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
      createRequestId: () => `dir-token-command-${++nextRequest}`,
      pipeConnector: createNodePipeTransport(),
    });
    await client.hello(1);
    return { host, client };
  }

  it("creates a directory-scoped token, lists it masked, and reveals it through the scope", async () => {
    const handler = directoryStubTokenCommandHandler();
    const { host, client } = await startHost(handler);

    const created = await client.executeClientTokenCommand({
      command: "create",
      protocolId: "anthropic-messages",
      scope: { type: "project", projectDir: "D:\projects\wire" },
      token: "canary-wire-dir-token-1",
    });
    expect(created.outcome).toBe("ok");
    expect(created.revision).toBe(1);
    expect(created.scopes).toEqual([
      {
        type: "project",
        projectDir: "D:\projects\wire",
        maskedToken: "canary-w…en-1",
      },
    ]);
    expect(JSON.stringify(created)).not.toContain("canary-wire-dir-token-1");

    const revealed = await client.executeClientTokenCommand({
      command: "reveal",
      protocolId: "anthropic-messages",
      scope: { type: "project", projectDir: "D:\projects\wire" },
    });
    expect(revealed).toEqual({
      outcome: "ok",
      revision: 1,
      token: "canary-wire-dir-token-1",
    });
    await client.close();
    await host.close();
  });

  it("rejects duplicate directory creates and backend canonicalization failures without raw paths", async () => {
    const handler = directoryStubTokenCommandHandler();
    const { host, client } = await startHost(handler);
    const create = () =>
      client.executeClientTokenCommand({
        command: "create",
        protocolId: "anthropic-messages",
        scope: { type: "project", projectDir: "D:\projects\wire" },
        token: "canary-wire-dir-token-1",
      });
    expect((await create()).outcome).toBe("ok");
    const duplicate = await create();
    expect(duplicate.outcome).toBe("already_exists");
    expect(duplicate.revision).toBe(1);

    const rejected = await client.executeClientTokenCommand({
      command: "create",
      protocolId: "anthropic-messages",
      scope: { type: "project", projectDir: "reject:not_found:C:\missing" },
    });
    expect(rejected).toEqual({
      outcome: "invalid_directory",
      revision: 1,
      reason: "not_found",
      error: "Selected directory is not usable as a client token scope",
    });
    expect(JSON.stringify(rejected)).not.toContain("missing");
    await client.close();
    await host.close();
  });

  it("rotates and removes a directory scope with the locked revision", async () => {
    const handler = directoryStubTokenCommandHandler();
    const { host, client } = await startHost(handler);
    await client.executeClientTokenCommand({
      command: "create",
      protocolId: "anthropic-messages",
      scope: { type: "project", projectDir: "D:\projects\wire" },
      token: "canary-wire-dir-token-1",
    });
    const rotated = await client.executeClientTokenCommand({
      command: "rotate",
      protocolId: "anthropic-messages",
      expectedRevision: 1,
      scope: { type: "project", projectDir: "D:\projects\wire" },
      token: "canary-wire-dir-token-2",
    });
    expect(rotated.outcome).toBe("ok");
    expect(rotated.revision).toBe(2);
    // A stale revision through the same scope conflicts.
    const stale = await client.executeClientTokenCommand({
      command: "rotate",
      protocolId: "anthropic-messages",
      expectedRevision: 1,
      scope: { type: "project", projectDir: "D:\projects\wire" },
      token: "canary-wire-dir-token-3",
    });
    expect(stale).toEqual({
      outcome: "conflict",
      revision: 2,
      error: "Client token revision is stale",
    });
    const removed = await client.executeClientTokenCommand({
      command: "remove",
      protocolId: "anthropic-messages",
      expectedRevision: 2,
      scope: { type: "project", projectDir: "D:\projects\wire" },
    });
    expect(removed.outcome).toBe("ok");
    expect(removed.revision).toBe(3);
    expect(removed.scopes).toEqual([]);
    await client.close();
    await host.close();
  });
});
