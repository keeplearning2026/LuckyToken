import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import type {
  PipeConnection,
  PipeSecurityPolicy,
  PipeServer,
  PipeTransport,
} from "./pipe-transport.js";

const nodeFallbackPolicy: PipeSecurityPolicy = Object.freeze({
  ownerSid: "unverified-by-node-runtime",
  daclProtected: false,
  accessMask: 0,
  rejectRemoteClients: false,
});

class NodePipeConnection implements PipeConnection {
  readonly #socket: Socket;
  #readInProgress = false;
  #terminalError: Error | undefined;
  #remainder: Buffer | undefined;
  readonly #closed: Promise<void>;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.pause();
    socket.on("error", (error) => {
      this.#terminalError = error;
    });
    this.#closed = new Promise((resolve) => socket.once("close", resolve));
  }

  async read(maxBytes: number): Promise<Buffer | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Pipe read size must be a positive integer");
    }
    if (this.#readInProgress) {
      throw new Error("Concurrent reads are not supported");
    }
    this.#readInProgress = true;
    try {
      for (;;) {
        const available = this.#takeRemainder(maxBytes);
        if (available !== undefined) return available;
        if (this.#terminalError !== undefined) throw this.#terminalError;
        if (this.#socket.readableEnded || this.#socket.destroyed) return null;
        const chunk = await this.#waitForData();
        if (chunk !== null) this.#remainder = chunk;
      }
    } finally {
      this.#readInProgress = false;
    }
  }

  async write(bytes: Buffer): Promise<void> {
    if (this.#socket.destroyed) {
      throw this.#terminalError ?? new Error("Pipe connection is closed");
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(bytes, (error) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (!this.#socket.destroyed) this.#socket.destroy();
    await this.#closed;
  }

  #takeRemainder(maxBytes: number): Buffer | undefined {
    if (this.#remainder === undefined) return undefined;
    if (this.#remainder.length <= maxBytes) {
      const result = this.#remainder;
      this.#remainder = undefined;
      return result;
    }
    const result = this.#remainder.subarray(0, maxBytes);
    this.#remainder = this.#remainder.subarray(maxBytes);
    return result;
  }

  async #waitForData(): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve) => {
      const finish = (chunk: Buffer | null) => {
        this.#socket.pause();
        this.#socket.off("data", onData);
        this.#socket.off("end", onEnd);
        this.#socket.off("error", onError);
        this.#socket.off("close", onEnd);
        resolve(chunk);
      };
      const onData = (chunk: Buffer) => finish(chunk);
      const onEnd = () => finish(null);
      const onError = () => finish(null);
      this.#socket.once("data", onData);
      this.#socket.once("end", onEnd);
      this.#socket.once("error", onError);
      this.#socket.once("close", onEnd);
      this.#socket.resume();
    });
  }
}

class NodePipeServer implements PipeServer {
  readonly #server: Server;
  readonly #accepted: PipeConnection[] = [];
  readonly #waiters: Array<(connection: PipeConnection | null) => void> = [];
  #closed = false;

  constructor(server: Server) {
    this.#server = server;
    server.on("connection", (socket) => {
      const connection = new NodePipeConnection(socket);
      if (this.#closed) {
        void connection.close();
        return;
      }
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#accepted.push(connection);
      else waiter(connection);
    });
  }

  async accept(): Promise<PipeConnection | null> {
    const connection = this.#accepted.shift();
    if (connection !== undefined) return connection;
    if (this.#closed) return null;
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  securityPolicy(): PipeSecurityPolicy {
    return nodeFallbackPolicy;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const resolve of this.#waiters.splice(0)) resolve(null);
    await Promise.all(
      this.#accepted.splice(0).map((connection) => connection.close()),
    );
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
}

async function listen(pipeName: string): Promise<PipeServer> {
  const server = createServer();
  const pipeServer = new NodePipeServer(server);
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(pipeName);
  });
  return pipeServer;
}

async function connect(pipeName: string): Promise<PipeConnection> {
  const socket = createConnection(pipeName);
  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  return new NodePipeConnection(socket);
}

export function createNodePipeTransport(): PipeTransport {
  return Object.freeze({ listen, connect });
}
