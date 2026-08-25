import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexDirectHttpFetch } from "../../src/integrations/codex/direct-http-fetch.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Direct HTTP test server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("Codex Direct raw HTTP transport", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it("aborts the upstream response socket after headers are received", async () => {
    let upstreamClosed = false;
    const server = createServer((_request, response) => {
      response.once("close", () => {
        upstreamClosed = true;
      });
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from([1, 2, 3]));
    });
    servers.push(server);
    const port = await listen(server);
    const controller = new AbortController();

    const response = await createCodexDirectHttpFetch()(
      `http://127.0.0.1:${port}/slow`,
      {
        method: "POST",
        body: Uint8Array.from([9]),
        signal: controller.signal,
      },
    );
    controller.abort(new Error("caller cancelled"));

    await expect(response.arrayBuffer()).rejects.toThrow();
    await expect.poll(() => upstreamClosed).toBe(true);
  });

  it("preserves caller bytes/headers and compressed upstream representation", async () => {
    const requestBytes = Uint8Array.from([0x00, 0xff, 0x28, 0xb5, 0x2f, 0xfd]);
    const compressedResponse = gzipSync(Buffer.from('{"ok":true}', "utf8"));
    let observedBody = Buffer.alloc(0);
    let observedAcceptEncoding: string | undefined;
    let observedExtension: string | undefined;
    const server = createServer((request, response) => {
      observedAcceptEncoding = request.headers["accept-encoding"];
      observedExtension = request.headers["x-codex-extension"] as string | undefined;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        observedBody = Buffer.concat(chunks);
        response.writeHead(207, "Upstream Partial", {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(compressedResponse.byteLength),
          digest: "sha-256=:raw-representation:",
          "x-upstream-extension": "preserve-me",
        });
        response.end(compressedResponse);
      });
    });
    servers.push(server);
    const port = await listen(server);

    const response = await createCodexDirectHttpFetch()(
      `http://127.0.0.1:${port}/direct?raw=query`,
      {
        method: "POST",
        headers: {
          "accept-encoding": "gzip, br",
          "content-type": "application/octet-stream",
          "x-codex-extension": "caller-value",
        },
        body: requestBytes,
        redirect: "manual",
      },
    );

    expect({
      status: response.status,
      statusText: response.statusText,
      acceptEncoding: observedAcceptEncoding,
      callerExtension: observedExtension,
      requestBody: Array.from(observedBody),
      responseEncoding: response.headers.get("content-encoding"),
      responseLength: response.headers.get("content-length"),
      digest: response.headers.get("digest"),
      upstreamExtension: response.headers.get("x-upstream-extension"),
      responseBody: Array.from(new Uint8Array(await response.arrayBuffer())),
    }).toEqual({
      status: 207,
      statusText: "Upstream Partial",
      acceptEncoding: "gzip, br",
      callerExtension: "caller-value",
      requestBody: Array.from(requestBytes),
      responseEncoding: "gzip",
      responseLength: String(compressedResponse.byteLength),
      digest: "sha-256=:raw-representation:",
      upstreamExtension: "preserve-me",
      responseBody: Array.from(compressedResponse),
    });
  });
});
