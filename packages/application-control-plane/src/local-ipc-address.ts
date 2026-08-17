import { posix } from "node:path";

export interface LocalIpcAddressOptions {
  readonly platform: NodeJS.Platform;
  readonly randomId: string;
  readonly runtimeDirectory?: string;
}

export function createLocalIpcAddress(options: LocalIpcAddressOptions): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(options.randomId)) {
    throw new Error("Local IPC random id contains unsupported characters");
  }
  if (options.platform === "win32") {
    return `\\\\.\\pipe\\luckytoken-${options.randomId}`;
  }
  if (options.runtimeDirectory === undefined || options.runtimeDirectory.length === 0) {
    throw new Error("Unix local IPC requires a runtime directory");
  }
  return posix.join(
    options.runtimeDirectory.replaceAll("\\", "/"),
    `luckytoken-${options.randomId}.sock`,
  );
}
