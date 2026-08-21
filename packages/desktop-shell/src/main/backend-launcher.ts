export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SpawnedBackend {
  readonly pid: number;
  readonly exited: Promise<ProcessExit>;
  release(): void;
}

export interface BackendLauncher {
  launch(): Promise<SpawnedBackend>;
}
