import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createControlPlaneDiscovery,
  parseControlPlaneDescriptor,
} from "../../src/control-plane-discovery.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "Token-discovery-"));
  return {
    path: join(directory, "control-plane.json"),
    discovery: createControlPlaneDiscovery({
      path: join(directory, "control-plane.json"),
      createTemporaryId: (() => {
        let next = 0;
        return () => String(++next);
      })(),
    }),
  };
}

const firstEndpoint = Object.freeze({
  address: "\\\\.\\pipe\\Token-first-owner",
  capability: "first-owner-capability-012345678901234567890",
});
const secondEndpoint = Object.freeze({
  address: "\\\\.\\pipe\\Token-second-owner",
  capability: "second-owner-capability-01234567890123456789",
});

describe("Control Plane discovery publication", () => {
  it("rejects the removed pipeName descriptor contract", () => {
    expect(() =>
      parseControlPlaneDescriptor({
        pipeName: "\\\\.\\pipe\\removed-contract",
        capability: "removed-contract-capability-01234567890123456789",
      }),
    ).toThrow("Invalid Control Plane descriptor");
  });

  it("treats an absent descriptor as normal discovery state", async () => {
    const { discovery } = await fixture();
    await expect(discovery.read()).resolves.toBeUndefined();
  });

  it("publishes and withdraws one endpoint without assigning liveness semantics to the file", async () => {
    const { path, discovery } = await fixture();
    const publication = await discovery.publish(firstEndpoint);
    try {
      await expect(discovery.read()).resolves.toEqual(firstEndpoint);
      expect(await readFile(path, "utf8")).toBe(JSON.stringify(firstEndpoint));
    } finally {
      await publication.close();
    }
    await expect(discovery.read()).resolves.toBeUndefined();
  });

  it("lets a new publication replace stale descriptor content and stale close cannot remove it", async () => {
    const { discovery } = await fixture();
    const first = await discovery.publish(firstEndpoint);
    const second = await discovery.publish(secondEndpoint);
    try {
      await expect(discovery.read()).resolves.toEqual(secondEndpoint);
      await first.close();
      await expect(discovery.read()).resolves.toEqual(secondEndpoint);
    } finally {
      await second.close();
    }
    await expect(discovery.read()).resolves.toBeUndefined();
  });

  it("fails explicitly when a present descriptor is malformed", async () => {
    const { path, discovery } = await fixture();
    await writeFile(path, "{not-json", "utf8");
    await expect(discovery.read()).rejects.toThrow("Failed to read Control Plane descriptor");
  });
});
