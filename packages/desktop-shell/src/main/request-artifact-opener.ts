import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type {
  RequestArtifactChunkReadResult,
  RequestArtifactGetInput,
} from "@token/application-control-plane/control-plane";

import {
  diagnosticArtifactFileName,
  type DesktopRequestArtifactOpenInput,
  type DesktopRequestArtifactOpenResult,
} from "../shared/desktop-api.js";

const ARTIFACT_READ_PAGE_BYTES = 256 * 1_024;
const MAX_OPEN_ARTIFACT_BYTES = 64 * 1_024 * 1_024;
const UNAVAILABLE: DesktopRequestArtifactOpenResult = Object.freeze({
  outcome: "unavailable",
  message: "Capture file is unavailable.",
});

export interface DesktopRequestArtifactReader {
  getRequestArtifact(
    input: RequestArtifactGetInput,
  ): Promise<RequestArtifactChunkReadResult>;
}

export interface DesktopRequestArtifactPlatform {
  temporaryDirectory(): string;
  openPath(path: string): Promise<boolean>;
}

export interface DesktopRequestArtifactOpener {
  open(
    input: DesktopRequestArtifactOpenInput,
  ): Promise<DesktopRequestArtifactOpenResult>;
  dispose(): Promise<void>;
}

async function writeComplete(
  file: FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (result.bytesWritten <= 0) throw new Error("Capture file write stalled");
    offset += result.bytesWritten;
  }
}

function validOpenInput(input: DesktopRequestArtifactOpenInput): boolean {
  return input.requestId.length > 0 &&
    input.requestId.length <= 256 &&
    input.artifactId.length > 0 &&
    input.artifactId.length <= 256 &&
    (input.mediaType === undefined || input.mediaType.length <= 256);
}

/**
 * Desktop-only workflow for opening one sanitized capture. It pages through
 * the Control Plane into a private temporary file, so neither Renderer state
 * nor one Electron IPC message ever contains a complete 64 MiB artifact.
 */
export function createDesktopRequestArtifactOpener(options: {
  readonly reader: () => DesktopRequestArtifactReader;
  readonly platform: DesktopRequestArtifactPlatform;
}): DesktopRequestArtifactOpener {
  const openedDirectories = new Set<string>();

  return Object.freeze({
    async open(
      input: DesktopRequestArtifactOpenInput,
    ): Promise<DesktopRequestArtifactOpenResult> {
      if (!validOpenInput(input)) return UNAVAILABLE;
      let directory: string | undefined;
      try {
        directory = await mkdtemp(
          join(options.platform.temporaryDirectory(), "Token-capture-"),
        );
        const filePath = join(
          directory,
          diagnosticArtifactFileName(input.artifactId, input.mediaType),
        );
        const file = await open(filePath, "wx", 0o600);
        try {
          let offset = 0;
          for (;;) {
            const response = await options.reader().getRequestArtifact({
              requestId: input.requestId,
              artifactId: input.artifactId,
              offset,
              limit: ARTIFACT_READ_PAGE_BYTES,
            });
            if (response.outcome !== "ok") throw new Error("Capture unavailable");
            const page = response.result;
            if (
              page.requestId !== input.requestId ||
              page.artifactId !== input.artifactId ||
              page.offset !== offset ||
              page.nextOffset < offset ||
              page.nextOffset > MAX_OPEN_ARTIFACT_BYTES
            ) {
              throw new Error("Invalid capture page");
            }
            const bytes = Buffer.from(page.dataBase64, "base64");
            if (bytes.byteLength !== page.nextOffset - offset) {
              throw new Error("Capture page length mismatch");
            }
            await writeComplete(file, bytes);
            if (page.complete) break;
            if (page.nextOffset === offset) throw new Error("Capture read stalled");
            offset = page.nextOffset;
          }
          await file.sync();
        } finally {
          await file.close();
        }
        if (!await options.platform.openPath(filePath)) {
          throw new Error("Capture file could not be opened");
        }
        openedDirectories.add(directory);
        return Object.freeze({ outcome: "opened" });
      } catch {
        if (directory !== undefined) {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
        return UNAVAILABLE;
      }
    },
    async dispose(): Promise<void> {
      const directories = [...openedDirectories];
      openedDirectories.clear();
      await Promise.allSettled(
        directories.map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
    },
  });
}
