import type {
  PipeConnection,
  PipeSecurityPolicy,
  PipeServer,
  PipeTransport,
} from "@luckytoken/application-control-plane/control-plane";

class MemoryChannel {
  readonly #chunks: Buffer[] = [];
  readonly #waiters: Array<(value: Buffer | null) => void> = [];
  #ended = false;

  async read(maxBytes: number): Promise<Buffer | null> {
    const available = this.#chunks.shift();
    if (available !== undefined) return this.#bounded(available, maxBytes);
    if (this.#ended) return null;
    const value = await new Promise<Buffer | null>((resolve) =>
      this.#waiters.push(resolve),
    );
    return value === null ? null : this.#bounded(value, maxBytes);
  }

  write(bytes: Buffer): void {
    if (this.#ended) throw new Error("Faultable pipe is closed");
    const copy = Buffer.from(bytes);
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#chunks.push(copy);
    else waiter(copy);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#chunks.splice(0);
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }

  #bounded(bytes: Buffer, maxBytes: number): Buffer {
    if (bytes.length <= maxBytes) return bytes;
    const head = bytes.subarray(0, maxBytes);
    this.#chunks.unshift(bytes.subarray(maxBytes));
    return head;
  }
}

class MemoryPipePair {
  readonly clientInbound = new MemoryChannel();
  readonly serverInbound = new MemoryChannel();
  #closed = false;

  client(): PipeConnection {
    return this.#connection(this.clientInbound, this.serverInbound);
  }

  server(): PipeConnection {
    return this.#connection(this.serverInbound, this.clientInbound);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.clientInbound.end();
    this.serverInbound.end();
  }

  #connection(inbound: MemoryChannel, outbound: MemoryChannel): PipeConnection {
    return {
      read: (maxBytes) => inbound.read(maxBytes),
      write: async (bytes) => outbound.write(bytes),
      close: async () => this.close(),
    };
  }
}

class FaultablePipeServer implements PipeServer {
  readonly #accepted: PipeConnection[] = [];
  readonly #waiters: Array<(connection: PipeConnection | null) => void> = [];
  readonly #policy: PipeSecurityPolicy;
  readonly #onClose: () => void;
  #closed = false;

  constructor(policy: PipeSecurityPolicy, onClose: () => void) {
    this.#policy = policy;
    this.#onClose = onClose;
  }

  connect(connection: PipeConnection): void {
    if (this.#closed) throw new Error("Faultable pipe server is closed");
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#accepted.push(connection);
    else waiter(connection);
  }

  async accept(): Promise<PipeConnection | null> {
    const accepted = this.#accepted.shift();
    if (accepted !== undefined) return accepted;
    if (this.#closed) return null;
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  securityPolicy(): PipeSecurityPolicy {
    return this.#policy;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }
}

export class FaultableControlPipe implements PipeTransport {
  readonly access = Object.freeze({
    mode: "strict-current-user" as const,
    ownerSid: "S-1-5-21-test-user",
    accessMask: 0x0012_019f,
  });
  readonly #policy: PipeSecurityPolicy = Object.freeze({
    ownerSid: this.access.ownerSid,
    daclProtected: true,
    accessMask: this.access.accessMask,
    rejectRemoteClients: true,
  });
  readonly #pairs = new Set<MemoryPipePair>();
  readonly #servers = new Map<string, FaultablePipeServer>();

  async listen(pipeName: string): Promise<PipeServer> {
    if (this.#servers.has(pipeName)) throw new Error("Pipe is already in use");
    const server = new FaultablePipeServer(this.#policy, () =>
      this.#servers.delete(pipeName),
    );
    this.#servers.set(pipeName, server);
    return server;
  }

  async connect(pipeName: string): Promise<PipeConnection> {
    const server = this.#servers.get(pipeName);
    if (server === undefined) throw new Error("Pipe is unavailable");
    const pair = new MemoryPipePair();
    this.#pairs.add(pair);
    server.connect(pair.server());
    return pair.client();
  }

  disconnectEstablishedConnections(): void {
    for (const pair of this.#pairs) pair.close();
    this.#pairs.clear();
  }
}
