import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDesktopRequestArtifactOpener } from "../src/main/request-artifact-opener.js";

describe("desktop request artifact opener", () => {
  it("opens the validated persisted capture directly without reading or copying it", async () => {
    const absolutePath = resolve("diagnostics/client-request-wire.json");
    const resolveRequestArtifactFile = vi.fn(async (input: {
      readonly requestId: string;
      readonly artifactId: string;
    }) => ({
      outcome: "ok" as const,
      result: { ...input, absolutePath },
    }));
    const openPath = vi.fn(async () => true);
    const opener = createDesktopRequestArtifactOpener({
      reader: () => ({ resolveRequestArtifactFile }),
      platform: { openPath },
    });

    await expect(opener.open({
      requestId: "request-1",
      artifactId: "client_request_wire",
    })).resolves.toEqual({ outcome: "opened" });

    expect(resolveRequestArtifactFile).toHaveBeenCalledWith({
      requestId: "request-1",
      artifactId: "client_request_wire",
    });
    expect(openPath).toHaveBeenCalledWith(absolutePath);
  });

  it("does not open a mismatched file reference", async () => {
    const openPath = vi.fn(async () => true);
    const opener = createDesktopRequestArtifactOpener({
      reader: () => ({
        resolveRequestArtifactFile: async () => ({
          outcome: "ok" as const,
          result: {
            requestId: "another-request",
            artifactId: "client_request_wire",
            absolutePath: resolve("diagnostics/client-request-wire.json"),
          },
        }),
      }),
      platform: { openPath },
    });

    await expect(opener.open({
      requestId: "request-1",
      artifactId: "client_request_wire",
    })).resolves.toEqual({
      outcome: "unavailable",
      message: "Capture file is unavailable.",
    });
    expect(openPath).not.toHaveBeenCalled();
  });
});
