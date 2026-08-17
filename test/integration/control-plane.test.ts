import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ApplicationStatus,
  type ControlPlaneEndpoint,
  type PipeConnection,
  type PipeServer,
} from "@luckytoken/application-control-plane/control-plane";
import { FaultableControlPipe } from "../support/faultable-control-pipe.js";

let nextId = 0;
function endpoint(): ControlPlaneEndpoint {
  nextId += 1;
  return {
    address: `\\\\.\\pipe\\ticket-01-${process.pid}-${nextId}`,
    capability: "test-capability-012345678901234567890123456789",
  };
}

const transport = createNodePipeTransport();
const clientDependencies = {
  createRequestId: () => `request-${++nextId}`,
  pipeConnector: transport,
};
const hostDependencies = {
  pipeServerFactory: transport,
  access: nodePipeFallbackAccess,
};

function encodeRawFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function readExact(
  connection: PipeConnection,
  byteLength: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let received = 0;
  while (received < byteLength) {
    const chunk = await connection.read(byteLength - received);
    if (chunk === null) return null;
    chunks.push(chunk);
    received += chunk.length;
  }
  return Buffer.concat(chunks);
}

async function readRawFrame(connection: PipeConnection): Promise<unknown> {
  const header = await readExact(connection, 4);
  if (header === null) return undefined;
  const body = await readExact(connection, header.readUInt32BE(0));
  return body === null ? undefined : JSON.parse(body.toString("utf8"));
}

class PendingReadConnection implements PipeConnection {
  readonly closed: Promise<void>;
  readonly #resolveClosed: () => void;
  readonly #read: Promise<Buffer | null>;
  readonly #resolveRead: (value: Buffer | null) => void;
  #didClose = false;

  constructor() {
    let resolveClosed: (() => void) | undefined;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed!;
    let resolveRead: ((value: Buffer | null) => void) | undefined;
    this.#read = new Promise((resolve) => {
      resolveRead = resolve;
    });
    this.#resolveRead = resolveRead!;
  }

  async read(): Promise<Buffer | null> {
    return this.#read;
  }

  async write(): Promise<void> {}

  async close(): Promise<void> {
    if (this.#didClose) return;
    this.#didClose = true;
    this.#resolveRead(null);
    this.#resolveClosed();
  }
}

class AcceptDuringCloseServer implements PipeServer {
  readonly connection = new PendingReadConnection();
  readonly accepting: Promise<void>;
  readonly #resolveAccepting: () => void;
  readonly #accepted: Promise<PipeConnection | null>;
  readonly #resolveAccepted: (connection: PipeConnection | null) => void;

  constructor() {
    let resolveAccepting: (() => void) | undefined;
    this.accepting = new Promise((resolve) => {
      resolveAccepting = resolve;
    });
    this.#resolveAccepting = resolveAccepting!;
    let resolveAccepted:
      | ((connection: PipeConnection | null) => void)
      | undefined;
    this.#accepted = new Promise((resolve) => {
      resolveAccepted = resolve;
    });
    this.#resolveAccepted = resolveAccepted!;
  }

  async accept(): Promise<PipeConnection | null> {
    this.#resolveAccepting();
    return this.#accepted;
  }

  securityPolicy() {
    return {
      ownerSid: "unverified",
      daclProtected: false,
      accessMask: 0,
      rejectRemoteClients: false,
    };
  }

  async close(): Promise<void> {
    this.#resolveAccepted(this.connection);
  }
}

class AlwaysFailingAcceptServer implements PipeServer {
  acceptCalls = 0;

  async accept(): Promise<PipeConnection | null> {
    this.acceptCalls += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw new Error("synthetic permanent accept failure");
  }

  securityPolicy() {
    return {
      ownerSid: "unverified",
      daclProtected: false,
      accessMask: 0,
      rejectRemoteClients: false,
    };
  }

  async close(): Promise<void> {}
}

describe("Application Control Plane public seam", () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  const rawServers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      rawServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  it("rejects an in-flight request when an established connection is lost", async () => {
    const target = endpoint();
    let accepted: ((socket: Socket) => void) | undefined;
    const socketAccepted = new Promise<Socket>((resolve) => {
      accepted = resolve;
    });
    const rawServer = createServer((socket) => accepted?.(socket));
    rawServers.push(rawServer);
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(target.address, resolve);
    });
    const client = await connectControlPlane(target, clientDependencies);
    const serverSocket = await socketAccepted;
    expect(client.disconnected).toBeInstanceOf(Promise);

    const pendingHello = client.hello(1);
    serverSocket.destroy();

    await expect(
      Promise.race([
        pendingHello,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("request remained pending")), 100),
        ),
      ]),
    ).rejects.toThrow("disconnected");
    await expect(client.disconnected).resolves.toEqual({
      reason: "transport_lost",
    });
    await client.close();
  });

  it("closes the host without hanging while clients remain connected", async () => {
    const server = await startControlPlane({
      ...hostDependencies,
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, clientDependencies);
    await client.hello(1);

    const closeResult = await Promise.race([
      server.close().then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);
    if (closeResult === "hung") await client.close();
    expect(closeResult).toBe("closed");
    servers.splice(servers.indexOf(server), 1);
    await expect(client.disconnected).resolves.toEqual({
      reason: "transport_lost",
    });
    await client.close();
  });

  it("closes a connection accepted concurrently with host shutdown", async () => {
    const pipeServer = new AcceptDuringCloseServer();
    const server = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      pipeServerFactory: { listen: async () => pipeServer },
      access: nodePipeFallbackAccess,
    });
    await pipeServer.accepting;

    const result = await Promise.race([
      server.close().then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);
    if (result === "hung") await pipeServer.connection.close();

    expect(result).toBe("closed");
    await expect(pipeServer.connection.closed).resolves.toBeUndefined();
  });

  it("terminates its accept loop after a permanent transport failure", async () => {
    const pipeServer = new AlwaysFailingAcceptServer();
    const server = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      pipeServerFactory: { listen: async () => pipeServer },
      access: nodePipeFallbackAccess,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const closeResult = await Promise.race([
      server.close().then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);

    expect(closeResult).toBe("closed");
    expect(pipeServer.acceptCalls).toBe(1);
  });

  it("settles disconnect when the transport cannot confirm client close", async () => {
    const neverReads = new Promise<Buffer | null>(() => undefined);
    const client = await connectControlPlane(endpoint(), {
      createRequestId: () => "close-failure-request",
      pipeConnector: {
        connect: async () => ({
          read: async () => neverReads,
          write: async () => undefined,
          close: async () => {
            throw new Error("synthetic close failure");
          },
        }),
      },
    });

    await expect(client.close()).rejects.toThrow("synthetic close failure");
    await expect(
      Promise.race([
        client.disconnected,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("disconnect remained pending")), 100),
        ),
      ]),
    ).resolves.toEqual({ reason: "closed" });
  });

  it("negotiates exact v1 identity and rejects commands until a compatible hello", async () => {
    const server = await startControlPlane({
      ...hostDependencies,
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "1.2.3-test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, clientDependencies);

    await expect(client.hello(2)).resolves.toEqual({
      type: "incompatible",
      requestedVersion: 2,
      supportedVersions: [1],
    });
    await expect(client.getStatus()).rejects.toThrow("hello_required");
    await expect(client.hello(1)).resolves.toEqual({
      type: "compatible",
      application: { id: "luckytoken", version: "1.2.3-test" },
      contractVersion: 1,
    });
    await expect(client.getStatus()).resolves.toEqual({
      sequence: 0,
      modelDataPlane: "stopped",
      provider: "unconfigured",
    });
    const revokedEvents: unknown[] = [];
    await client.subscribe((event) => revokedEvents.push(event));
    await expect(client.hello(2)).resolves.toMatchObject({
      type: "incompatible",
    });
    await server.publishStatus({
      modelDataPlane: "running",
      provider: "unconfigured",
    });
    expect(revokedEvents).toEqual([]);
    await expect(client.getStatus()).rejects.toThrow("hello_required");
    await expect(client.hello(1)).resolves.toMatchObject({
      type: "compatible",
    });
    await expect(client.getStatus()).resolves.toMatchObject({
      sequence: 1,
    });
    await client.close();
  });

  it("delivers two monotonic typed events without status credentials", async () => {
    const server = await startControlPlane({
      ...hostDependencies,
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, clientDependencies);
    await client.hello(1);
    const events: unknown[] = [];
    await client.subscribe((event) => events.push(event));

    await server.publishStatus({
      modelDataPlane: "running",
      provider: "configured",
      apiKey: "event-provider-secret",
    } as ApplicationStatus);
    await server.publishStatus({
      modelDataPlane: "stopping",
      provider: "configured",
      Authorization: "event-client-secret",
    } as ApplicationStatus);

    await expect.poll(() => events).toEqual([
      {
        type: "status_changed",
        sequence: 1,
        snapshot: {
          sequence: 1,
          modelDataPlane: "running",
          provider: "configured",
        },
      },
      {
        type: "status_changed",
        sequence: 2,
        snapshot: {
          sequence: 2,
          modelDataPlane: "stopping",
          provider: "configured",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("event-provider-secret");
    expect(JSON.stringify(events)).not.toContain("event-client-secret");
    await client.close();
  });

  it("reports stopped, running, stopping, and stopped lifecycle snapshots", async () => {
    const server = await startControlPlane({
      ...hostDependencies,
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
    });
    servers.push(server);
    const client = await connectControlPlane(
      server.endpoint,
      clientDependencies,
    );
    await expect(client.hello(1)).resolves.toMatchObject({
      type: "compatible",
    });
    await expect(client.getStatus()).resolves.toMatchObject({
      sequence: 0,
      modelDataPlane: "stopped",
    });

    await server.publishStatus({
      modelDataPlane: "running",
      provider: "unconfigured",
      Authorization: "secret",
    } as ApplicationStatus);
    await expect(client.getStatus()).resolves.toEqual({
      sequence: 1,
      modelDataPlane: "running",
      provider: "unconfigured",
    });
    await server.publishStatus({
      modelDataPlane: "stopping",
      provider: "unconfigured",
    });
    await server.publishStatus({
      modelDataPlane: "stopped",
      provider: "unconfigured",
    });
    await expect(client.getStatus()).resolves.toEqual({
      sequence: 3,
      modelDataPlane: "stopped",
      provider: "unconfigured",
    });
    await client.close();
  });

  it("requires the per-instance capability before commands and never echoes it", async () => {
    const server = await startControlPlane({
      ...hostDependencies,
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
    });
    servers.push(server);
    const client = await connectControlPlane(
      {
        ...server.endpoint,
        capability: "wrong-capability-012345678901234567890123456",
      },
      clientDependencies,
    );

    const error = await client.hello(1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("unauthorized");
    expect(String(error)).not.toContain(
      "wrong-capability-012345678901234567890123456",
    );
    await expect(client.getStatus()).rejects.toThrow("hello_required");
    await client.close();
  });

  it("bounds malformed, oversized, and unknown wire input without crashing the host", async () => {
    const target = endpoint();
    const server = await startControlPlane({
      ...hostDependencies,
      endpoint: target,
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
    });
    servers.push(server);
    const raw = await transport.connect(target.address);

    await raw.write(
      encodeRawFrame({
        type: "hello",
        requestId: "raw-hello",
        contractVersion: 1,
        capability: target.capability,
      }),
    );
    const hello = await readRawFrame(raw);
    expect(hello).toEqual({
      type: "hello_result",
      requestId: "raw-hello",
      result: {
        type: "compatible",
        application: { id: "luckytoken", version: "test" },
        contractVersion: 1,
      },
    });
    expect(JSON.stringify(hello)).not.toContain(target.capability);

    await raw.write(
      encodeRawFrame({
        type: "hello",
        requestId: "malformed-hello",
        capability: target.capability,
      }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "malformed-hello",
      code: "invalid_request",
    });
    await raw.write(
      encodeRawFrame({ type: "get_status", requestId: "after-bad-hello" }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "after-bad-hello",
      code: "hello_required",
    });
    await raw.write(
      encodeRawFrame({
        type: "hello",
        requestId: "raw-reauthorize",
        contractVersion: 1,
        capability: target.capability,
      }),
    );
    expect(await readRawFrame(raw)).toMatchObject({
      type: "hello_result",
      requestId: "raw-reauthorize",
      result: { type: "compatible" },
    });
    await raw.write(
      encodeRawFrame({
        type: "hello",
        requestId: "wrong-capability-hello",
        contractVersion: 1,
        capability: "wrong-capability-secret-012345678901234567890",
      }),
    );
    const wrongCapability = await readRawFrame(raw);
    expect(wrongCapability).toEqual({
      type: "error",
      requestId: "wrong-capability-hello",
      code: "unauthorized",
    });
    expect(JSON.stringify(wrongCapability)).not.toContain(
      "wrong-capability-secret-012345678901234567890",
    );
    await raw.write(
      encodeRawFrame({ type: "get_status", requestId: "after-wrong-capability" }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "after-wrong-capability",
      code: "hello_required",
    });
    await raw.write(
      encodeRawFrame({
        type: "hello",
        requestId: "raw-second-reauthorize",
        contractVersion: 1,
        capability: target.capability,
      }),
    );
    expect(await readRawFrame(raw)).toMatchObject({
      type: "hello_result",
      requestId: "raw-second-reauthorize",
      result: { type: "compatible" },
    });

    await raw.write(
      encodeRawFrame({
        type: "future_command",
        requestId: "unknown-1",
        password: "unknown-command-secret",
      }),
    );
    const unknown = await readRawFrame(raw);
    expect(unknown).toEqual({
      type: "error",
      requestId: "unknown-1",
      code: "unknown_command",
    });
    expect(JSON.stringify(unknown)).not.toContain("unknown-command-secret");

    await raw.write(
      encodeRawFrame({
        type: "runtime_command",
        requestId: "invalid-runtime-command",
        command: "launch_with_secret",
        secret: "malformed-runtime-secret",
      }),
    );
    const invalidRuntimeCommand = await readRawFrame(raw);
    expect(invalidRuntimeCommand).toEqual({
      type: "error",
      requestId: "invalid-runtime-command",
      code: "invalid_request",
    });
    expect(JSON.stringify(invalidRuntimeCommand)).not.toContain(
      "malformed-runtime-secret",
    );

    await raw.write(
      encodeRawFrame({
        type: "future_command",
        requestId: target.capability,
      }),
    );
    const capabilityAsRequestId = await readRawFrame(raw);
    expect(capabilityAsRequestId).toEqual({
      type: "error",
      requestId: "",
      code: "unknown_command",
    });
    expect(JSON.stringify(capabilityAsRequestId)).not.toContain(
      target.capability,
    );

    const malformedBody = Buffer.from(
      '{"type":"hello","password":"malformed-frame-secret"',
      "utf8",
    );
    const malformedHeader = Buffer.alloc(4);
    malformedHeader.writeUInt32BE(malformedBody.length);
    await raw.write(Buffer.concat([malformedHeader, malformedBody]));
    const malformed = await readRawFrame(raw);
    expect(malformed).toEqual({
      type: "error",
      requestId: "",
      code: "invalid_request",
    });
    expect(JSON.stringify(malformed)).not.toContain("malformed-frame-secret");
    await raw.write(
      encodeRawFrame({ type: "get_status", requestId: "after-malformed-json" }),
    );
    expect(await readRawFrame(raw)).toEqual({
      type: "error",
      requestId: "after-malformed-json",
      code: "hello_required",
    });
    await raw.close();

    const oversized = await transport.connect(target.address);
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(1024 * 1024 + 1);
    await oversized.write(oversizedHeader);
    await expect(oversized.read(1)).resolves.toBeNull();

    const healthy = await connectControlPlane(target, clientDependencies);
    await expect(healthy.hello(1)).resolves.toMatchObject({
      type: "compatible",
    });
    await healthy.close();
  });

  it("requires a non-empty local transport address and refuses false strict access claims", async () => {
    await expect(
      startControlPlane({
        ...hostDependencies,
        endpoint: {
          address: "",
          capability: "local-only-capability-012345678901234567890",
        },
        application: { id: "luckytoken", version: "test" },
        initialStatus: {
          modelDataPlane: "stopped",
          provider: "unconfigured",
        },
      }),
    ).rejects.toThrow("Invalid local Control Plane endpoint");

    await expect(
      startControlPlane({
        endpoint: endpoint(),
        application: { id: "luckytoken", version: "test" },
        initialStatus: {
          modelDataPlane: "stopped",
          provider: "unconfigured",
        },
        pipeServerFactory: transport,
        access: {
          mode: "strict-current-user",
          ownerSid: "S-1-5-21-real-user",
          accessMask: 0x0012_019f,
        },
      }),
    ).rejects.toThrow("required current-user access policy");
  });

  it("closes Node fallback connections queued before a consumer accepts them", async () => {
    const target = endpoint();
    const pipeServer = await transport.listen(target.address);
    const queuedConnection = await transport.connect(target.address);
    const peerClosed = queuedConnection.read(1);

    await pipeServer.close();

    await expect(peerClosed).resolves.toBeNull();
    await queuedConnection.close();
  });

  it("recovers from event-connection loss using a fresh snapshot without replay", async () => {
    const faultablePipe = new FaultableControlPipe();
    const server = await startControlPlane({
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      pipeServerFactory: faultablePipe,
      access: faultablePipe.access,
    });
    servers.push(server);
    const dependencies = {
      createRequestId: () => `fault-request-${++nextId}`,
      pipeConnector: faultablePipe,
    };
    const first = await connectControlPlane(server.endpoint, dependencies);
    await first.hello(1);
    await expect(first.getStatus()).resolves.toEqual({
      sequence: 0,
      modelDataPlane: "stopped",
      provider: "unconfigured",
    });
    const firstEvents: number[] = [];
    await first.subscribe((event) => firstEvents.push(event.sequence));

    await server.publishStatus({
      modelDataPlane: "running",
      provider: "unconfigured",
    });
    await expect.poll(() => firstEvents).toEqual([1]);

    faultablePipe.disconnectEstablishedConnections();
    await expect(first.disconnected).resolves.toEqual({
      reason: "transport_lost",
    });
    await server.publishStatus({
      modelDataPlane: "stopping",
      provider: "unconfigured",
    });
    await first.close();

    const next = await connectControlPlane(server.endpoint, dependencies);
    await next.hello(1);
    await expect(next.getStatus()).resolves.toEqual({
      sequence: 2,
      modelDataPlane: "stopping",
      provider: "unconfigured",
    });
    const later: number[] = [];
    await next.subscribe((event) => later.push(event.sequence));
    expect(later).toEqual([]);
    await server.publishStatus({
      modelDataPlane: "stopped",
      provider: "unconfigured",
      cookie: "must-not-leak",
    } as ApplicationStatus);
    await expect.poll(() => later).toEqual([3]);
    await next.close();
  });

  it("sends a wire unsubscribe that stops later status events", async () => {
    const server = await startControlPlane({
      ...hostDependencies,
      endpoint: endpoint(),
      application: { id: "luckytoken", version: "test" },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
    });
    servers.push(server);
    const client = await connectControlPlane(server.endpoint, clientDependencies);
    await client.hello(1);
    const sequences: number[] = [];
    const unsubscribe = await client.subscribe((event) =>
      sequences.push(event.sequence),
    );

    await server.publishStatus({
      modelDataPlane: "running",
      provider: "unconfigured",
    });
    await expect.poll(() => sequences).toEqual([1]);
    await unsubscribe();
    await server.publishStatus({
      modelDataPlane: "stopping",
      provider: "unconfigured",
    });

    expect(sequences).toEqual([1]);
    await client.close();
  });
});
