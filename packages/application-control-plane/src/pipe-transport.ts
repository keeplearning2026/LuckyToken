export interface PipeSecurityPolicy {
  readonly ownerSid: string;
  readonly daclProtected: boolean;
  readonly accessMask: number;
  readonly rejectRemoteClients: boolean;
}

export interface PipeConnection {
  /** Resolves with at most maxBytes, or null after the peer closes. */
  read(maxBytes: number): Promise<Buffer | null>;
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface PipeServer {
  /** Resolves null after close; rejection terminates the host's accept loop. */
  accept(): Promise<PipeConnection | null>;
  securityPolicy(): PipeSecurityPolicy;
  close(): Promise<void>;
}

export interface PipeServerFactory {
  listen(pipeName: string): Promise<PipeServer>;
}

export interface PipeConnector {
  connect(pipeName: string): Promise<PipeConnection>;
}

export interface PipeTransport extends PipeServerFactory, PipeConnector {}

export type PipeAccessRequirement =
  | {
      readonly mode: "strict-current-user";
      readonly ownerSid: string;
      readonly accessMask: number;
    }
  | {
      readonly mode: "node-fallback";
      readonly acknowledgement:
        "node-runtime-does-not-guarantee-current-user-dacl";
    };

export const nodePipeFallbackAccess: PipeAccessRequirement = Object.freeze({
  mode: "node-fallback",
  acknowledgement: "node-runtime-does-not-guarantee-current-user-dacl",
});

export function assertPipeAccess(
  policy: PipeSecurityPolicy,
  requirement: PipeAccessRequirement,
): void {
  if (requirement.mode === "node-fallback") return;
  if (
    policy.ownerSid !== requirement.ownerSid ||
    !policy.daclProtected ||
    policy.accessMask !== requirement.accessMask ||
    !policy.rejectRemoteClients
  ) {
    throw new Error(
      "Control Plane pipe does not satisfy the required current-user access policy",
    );
  }
}
