import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopRequestArtifactOpener } from "../src/main/request-artifact-opener.js";

describe("desktop request artifact opener", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("pages a capture through the Control Plane into a readable local file", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-artifact-opener-test-"));
    roots.push(root);
    const body = Buffer.from('{\n  "safe": true\n}', "utf8");
    const openedPaths: string[] = [];
    const getRequestArtifact = vi.fn(async (input: {
      readonly requestId: string;
      readonly artifactId: string;
      readonly offset: number;
      readonly limit: number;
    }) => {
      const nextOffset = Math.min(body.byteLength, input.offset + 7);
      return {
        outcome: "ok" as const,
        result: {
          requestId: input.requestId,
          artifactId: input.artifactId,
          offset: input.offset,
          nextOffset,
          complete: nextOffset === body.byteLength,
          dataBase64: body.subarray(input.offset, nextOffset).toString("base64"),
        },
      };
    });
    const opener = createDesktopRequestArtifactOpener({
      reader: () => ({ getRequestArtifact }),
      platform: {
        temporaryDirectory: () => root,
        openPath: async (path) => {
          openedPaths.push(path);
          return true;
        },
      },
    });

    await expect(opener.open({
      requestId: "request-1",
      artifactId: "client_request_wire",
      mediaType: "application/json",
    })).resolves.toEqual({ outcome: "opened" });

    expect(openedPaths).toHaveLength(1);
    expect(openedPaths[0]).toMatch(/client-request-wire\.json$/u);
    await expect(readFile(openedPaths[0]!, "utf8")).resolves.toBe(body.toString("utf8"));
    expect(getRequestArtifact).toHaveBeenCalledTimes(3);

    await opener.dispose();
    await expect(access(openedPaths[0]!)).rejects.toThrow();
  });
});
