import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  parseControlPlaneDescriptor,
} from "@luckytoken/application-control-plane/control-plane";

const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function connect(descriptorPath) {
  let lastError;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    let client;
    try {
      const descriptor = parseControlPlaneDescriptor(
        JSON.parse(await readFile(descriptorPath, "utf8")),
      );
      client = await connectControlPlane(descriptor, {
        createRequestId: randomUUID,
        pipeConnector: createNodePipeTransport(),
      });
      const hello = await client.hello(controlPlaneVersion);
      assert.equal(hello.type, "compatible");
      return client;
    } catch (error) {
      lastError = error;
      await client?.close().catch(() => undefined);
      await delay(100);
    }
  }
  throw lastError ?? new Error("installed Control Plane did not become ready");
}

const [action, descriptorPath] = process.argv.slice(2);
if ((action !== "verify" && action !== "quit") || descriptorPath === undefined) {
  throw new Error(
    "usage: node scripts/certify-running-install.mjs <verify|quit> <descriptor-path>",
  );
}

const client = await connect(descriptorPath);
try {
  if (action === "quit") {
    const result = await client.executeApplicationCommand({
      command: "quit",
      acknowledged: true,
    });
    assert.ok(result.outcome === "drained" || result.outcome === "timed_out");
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome })}\n`);
  } else {
    let status;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      status = await client.getStatus();
      if (status.modelDataPlane === "running") break;
      if (status.modelDataPlane === "failed" || status.recovery !== undefined) break;
      await delay(50);
    }
    assert.equal(status?.modelDataPlane, "running");
    assert.equal(status?.recovery, undefined);
    assert.equal(status?.ownership?.owner.kind, "desktop");
    assert.equal(status?.dataPlane?.configuredOrigin, "http://127.0.0.1:3000");
    const catalog = await client.executeCatalogCommand({ command: "query" });
    assert.equal(catalog.outcome, "ok");
    const providerIds = catalog.snapshot.providers.map(
      (provider) => provider.providerId,
    );
    assert.ok(providerIds.includes("anthropic"));
    assert.ok(providerIds.includes("commandcode-private"));
    assert.ok(providerIds.includes("commandcode-goat"));
    process.stdout.write(
      `${JSON.stringify({
        backendPid: status.ownership.owner.pid,
        providerCount: providerIds.length,
      })}\n`,
    );
  }
} finally {
  await client.close();
}
