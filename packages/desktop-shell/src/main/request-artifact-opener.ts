import { isAbsolute } from "node:path";

import type {
  RequestArtifactFileReferenceReadResult,
  RequestArtifactFileResolveInput,
} from "@token/application-control-plane/control-plane";

import {
  type DesktopRequestArtifactOpenInput,
  type DesktopRequestArtifactOpenResult,
} from "../shared/desktop-api.js";

const UNAVAILABLE: DesktopRequestArtifactOpenResult = Object.freeze({
  outcome: "unavailable",
  message: "Capture file is unavailable.",
});

export interface DesktopRequestArtifactReader {
  resolveRequestArtifactFile(
    input: RequestArtifactFileResolveInput,
  ): Promise<RequestArtifactFileReferenceReadResult>;
}

export interface DesktopRequestArtifactPlatform {
  openPath(path: string): Promise<boolean>;
}

export interface DesktopRequestArtifactOpener {
  open(
    input: DesktopRequestArtifactOpenInput,
  ): Promise<DesktopRequestArtifactOpenResult>;
}

function validOpenInput(input: DesktopRequestArtifactOpenInput): boolean {
  return input.requestId.length > 0 &&
    input.requestId.length <= 256 &&
    input.artifactId.length > 0 &&
    input.artifactId.length <= 256;
}

/**
 * Desktop-only workflow for opening one already-sanitized capture. The
 * diagnostics authority validates the record and managed file path; Electron
 * Main hands that existing file directly to the operating system. The
 * Renderer receives neither the path nor body bytes.
 */
export function createDesktopRequestArtifactOpener(options: {
  readonly reader: () => DesktopRequestArtifactReader;
  readonly platform: DesktopRequestArtifactPlatform;
}): DesktopRequestArtifactOpener {
  return Object.freeze({
    async open(
      input: DesktopRequestArtifactOpenInput,
    ): Promise<DesktopRequestArtifactOpenResult> {
      if (!validOpenInput(input)) return UNAVAILABLE;
      try {
        const response = await options.reader().resolveRequestArtifactFile({
          requestId: input.requestId,
          artifactId: input.artifactId,
        });
        if (response.outcome !== "ok") throw new Error("Capture unavailable");
        const reference = response.result;
        if (
          reference.requestId !== input.requestId ||
          reference.artifactId !== input.artifactId ||
          !isAbsolute(reference.absolutePath)
        ) {
          throw new Error("Capture reference mismatch");
        }
        if (!await options.platform.openPath(reference.absolutePath)) {
          throw new Error("Capture file could not be opened");
        }
        return Object.freeze({ outcome: "opened" });
      } catch {
        return UNAVAILABLE;
      }
    },
  });
}
