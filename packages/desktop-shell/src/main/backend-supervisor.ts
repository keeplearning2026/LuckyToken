import type { ControlPlaneEndpoint } from "@luckytoken/application-control-plane/control-plane";

export interface BackendChild {
  readonly pid: number;
  release(): void;
}

export type BackendAttachment =
  | {
      readonly source: "existing";
      readonly endpoint: ControlPlaneEndpoint;
    }
  | {
      readonly source: "spawned";
      readonly endpoint: ControlPlaneEndpoint;
      readonly childPid: number;
    };

export interface BackendSupervisorDependencies {
  readonly discoverReadyBackend: () => Promise<ControlPlaneEndpoint | undefined>;
  readonly spawnBackend: () => Promise<BackendChild>;
  readonly waitForReadyBackend: () => Promise<ControlPlaneEndpoint>;
}

export interface BackendSupervisor {
  ensureRunning(): Promise<BackendAttachment>;
  current(): BackendAttachment | undefined;
  dispose(): Promise<void>;
}

export function createBackendSupervisor(
  dependencies: BackendSupervisorDependencies,
): BackendSupervisor {
  let attachment: BackendAttachment | undefined;
  let child: BackendChild | undefined;
  let starting: Promise<BackendAttachment> | undefined;

  const ensureRunning = async (): Promise<BackendAttachment> => {
    if (attachment !== undefined) return attachment;
    starting ??= (async () => {
      const existing = await dependencies.discoverReadyBackend();
      if (existing !== undefined) {
        attachment = Object.freeze({ source: "existing" as const, endpoint: existing });
        return attachment;
      }

      child = await dependencies.spawnBackend();
      try {
        const endpoint = await dependencies.waitForReadyBackend();
        attachment = Object.freeze({
          source: "spawned" as const,
          endpoint,
          childPid: child.pid,
        });
        return attachment;
      } catch (error) {
        child.release();
        child = undefined;
        throw error;
      }
    })();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  };

  return Object.freeze({
    ensureRunning,
    current: () => attachment,
    async dispose(): Promise<void> {
      child?.release();
      child = undefined;
      attachment = undefined;
    },
  });
}
