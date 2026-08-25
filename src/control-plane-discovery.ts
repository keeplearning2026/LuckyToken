import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseControlPlaneDescriptor as parseEndpointDescriptor,
  type ControlPlaneEndpoint,
} from "@token/application-control-plane/control-plane";

export interface ControlPlaneDiscoveryLocation {
  readonly homeDirectory: string;
  readonly overridePath?: string;
}

export function resolveControlPlaneDescriptorPath(
  location: ControlPlaneDiscoveryLocation,
): string {
  return location.overridePath === undefined
    ? join(location.homeDirectory, ".Token", "control-plane.json")
    : resolve(location.overridePath);
}

export interface DiscoveryPublication {
  close(): Promise<void>;
}

export interface ControlPlaneDiscovery {
  read(): Promise<ControlPlaneEndpoint | undefined>;
  publish(endpoint: ControlPlaneEndpoint): Promise<DiscoveryPublication>;
}

export interface CreateControlPlaneDiscoveryOptions {
  readonly path: string;
  readonly createTemporaryId?: () => string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export const parseControlPlaneDescriptor = parseEndpointDescriptor;

async function readPublishedDescriptor(
  path: string,
): Promise<ControlPlaneEndpoint | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error("Failed to read Control Plane descriptor");
  }
  try {
    return parseControlPlaneDescriptor(JSON.parse(serialized));
  } catch {
    throw new Error("Failed to read Control Plane descriptor");
  }
}

export function createControlPlaneDiscovery(
  options: CreateControlPlaneDiscoveryOptions,
): ControlPlaneDiscovery {
  const createTemporaryId = options.createTemporaryId ?? randomUUID;
  return Object.freeze({
    read: () => readPublishedDescriptor(options.path),
    async publish(endpoint: ControlPlaneEndpoint): Promise<DiscoveryPublication> {
      await mkdir(dirname(options.path), { recursive: true });
      const serialized = JSON.stringify(endpoint);
      const temporaryPath = `${options.path}.${createTemporaryId()}.tmp`;
      try {
        await writeFile(temporaryPath, serialized, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporaryPath, options.path);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }

      let closed = false;
      return Object.freeze({
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          try {
            const current = await readFile(options.path, "utf8");
            if (current === serialized) await rm(options.path, { force: true });
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        },
      });
    },
  });
}
