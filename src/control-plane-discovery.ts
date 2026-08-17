import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  parseControlPlaneDescriptor as parseEndpointDescriptor,
  type ControlPlaneEndpoint,
} from "@luckytoken/application-control-plane/control-plane";
import lockfile from "proper-lockfile";

// A crashed owner can be replaced after this interval. Ticket 05 may add
// process-liveness recovery; until then a live process paused beyond this
// window can lose its descriptor authority.
const descriptorLockStaleMs = 30_000;

export interface ControlPlaneDiscoveryLocation {
  readonly homeDirectory: string;
  readonly overridePath?: string;
}

export function resolveControlPlaneDescriptorPath(
  location: ControlPlaneDiscoveryLocation,
): string {
  return location.overridePath === undefined
    ? join(location.homeDirectory, ".luckytoken", "control-plane.json")
    : resolve(location.overridePath);
}

export interface ControlPlaneDescriptorLease {
  close(): Promise<void>;
}

export class ControlPlaneDescriptorOwnedError extends Error {
  readonly code = "CONTROL_PLANE_DESCRIPTOR_OWNED";

  constructor() {
    super("Control Plane descriptor is already owned");
    this.name = "ControlPlaneDescriptorOwnedError";
  }
}

interface PublishControlPlaneDescriptorOptions {
  readonly path: string;
  readonly endpoint: ControlPlaneEndpoint;
  readonly createTemporaryId: () => string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export const parseControlPlaneDescriptor = parseEndpointDescriptor;

export async function readControlPlaneDescriptor(
  path: string,
): Promise<ControlPlaneEndpoint> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Failed to read Control Plane descriptor");
  }
  return parseControlPlaneDescriptor(value);
}

export async function publishControlPlaneDescriptor(
  options: PublishControlPlaneDescriptorOptions,
): Promise<ControlPlaneDescriptorLease> {
  const serialized = JSON.stringify(options.endpoint);
  const temporaryPath = `${options.path}.${options.createTemporaryId()}.tmp`;
  let compromised: Error | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    try {
      release = await lockfile.lock(options.path, {
        realpath: false,
        retries: 0,
        stale: descriptorLockStaleMs,
        onCompromised: (error) => {
          compromised = error;
        },
      });
    } catch (error) {
      if (errorCode(error) === "ELOCKED") {
        throw new ControlPlaneDescriptorOwnedError();
      }
      throw error;
    }
    await writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, options.path);
    if (compromised !== undefined) {
      throw new Error("Control Plane descriptor ownership was compromised");
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await release?.().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (compromised === undefined) {
          const current = await readFile(options.path, "utf8");
          if (current === serialized) await rm(options.path, { force: true });
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        await release?.();
      }
    },
  };
}
