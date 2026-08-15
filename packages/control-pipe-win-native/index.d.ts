declare interface NativePipeSecurityPolicy {
  readonly ownerSid: string;
  readonly daclProtected: boolean;
  readonly accessMask: number;
  readonly rejectRemoteClients: boolean;
}

declare class NativePipeConnection {
  read(maxBytes: number): Promise<Buffer | null>;
  write(bytes: Buffer): Promise<void>;
  /** Explicitly required to cancel pending reads; GC is not a cancellation API. */
  close(): void;
}

declare class NativePipeServer {
  constructor(name: string);
  accept(): Promise<NativePipeConnection>;
  securityPolicy(): NativePipeSecurityPolicy;
  /** Explicitly required to cancel pending accepts; GC is not a cancellation API. */
  close(): void;
}

declare const nativeControlPipe: {
  readonly NativePipeConnection: typeof NativePipeConnection;
  readonly NativePipeServer: typeof NativePipeServer;
  readonly currentUserSid: () => string;
};

export = nativeControlPipe;
