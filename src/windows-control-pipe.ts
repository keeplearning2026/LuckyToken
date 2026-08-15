import { createRequire } from "node:module";

import type {
  PipeAccessRequirement,
  PipeConnection,
  PipeSecurityPolicy,
  PipeServer,
  PipeServerFactory,
} from "@luckytoken/application-control-plane/control-plane";

export const windowsControlPipeAccessMask = 0x0012_019f;
interface NativePipeConnection {
  read(maxBytes: number): Promise<Buffer | null>;
  write(bytes: Buffer): Promise<void>;
  close(): void;
}

interface NativePipeServerInstance {
  accept(): Promise<NativePipeConnection>;
  securityPolicy(): PipeSecurityPolicy;
  close(): void;
}

interface NativeControlPipeModule {
  readonly NativePipeServer: new (name: string) => NativePipeServerInstance;
  readonly currentUserSid: () => string;
}

const require = createRequire(import.meta.url);
const { NativePipeServer, currentUserSid } = require(
  "@luckytoken/control-pipe-win-native",
) as NativeControlPipeModule;

class WindowsPipeConnection implements PipeConnection {
  readonly #native: NativePipeConnection;
  #closed = false;

  constructor(native: NativePipeConnection) {
    this.#native = native;
  }

  async read(maxBytes: number): Promise<Buffer | null> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 0xffff_ffff
    ) {
      throw new Error("Native pipe read size is out of range");
    }
    return this.#native.read(maxBytes);
  }

  async write(bytes: Buffer): Promise<void> {
    await this.#native.write(bytes);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#native.close();
  }
}

class WindowsPipeServer implements PipeServer {
  readonly #native: NativePipeServerInstance;
  #closed = false;

  constructor(pipeName: string) {
    this.#native = new NativePipeServer(pipeName);
  }

  async accept(): Promise<PipeConnection | null> {
    if (this.#closed) return null;
    try {
      const accepted = new WindowsPipeConnection(await this.#native.accept());
      if (!this.#closed) return accepted;
      await accepted.close();
      return null;
    } catch (error) {
      if (this.#closed) return null;
      throw error;
    }
  }

  securityPolicy(): PipeSecurityPolicy {
    const policy = this.#native.securityPolicy();
    return Object.freeze({
      ownerSid: policy.ownerSid,
      daclProtected: policy.daclProtected,
      accessMask: policy.accessMask,
      rejectRemoteClients: policy.rejectRemoteClients,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#native.close();
  }
}

export interface WindowsControlPipeHost {
  readonly pipeServerFactory: PipeServerFactory;
  readonly access: PipeAccessRequirement & {
    readonly mode: "strict-current-user";
  };
}

export function createWindowsControlPipeHost(): WindowsControlPipeHost {
  const ownerSid = currentUserSid();
  return Object.freeze({
    pipeServerFactory: Object.freeze({
      listen: async (pipeName: string) => new WindowsPipeServer(pipeName),
    }),
    access: Object.freeze({
      mode: "strict-current-user",
      ownerSid,
      accessMask: windowsControlPipeAccessMask,
    }),
  });
}
