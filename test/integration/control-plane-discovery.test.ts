import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  publishControlPlaneDescriptor,
  readControlPlaneDescriptor,
  type ControlPlaneDescriptorLease,
} from "../../src/control-plane-discovery.js";

describe("Control Plane discovery ownership", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("does not overwrite or remove another live descriptor lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-discovery-"));
    directories.push(directory);
    const path = join(directory, "control-plane.json");
    const firstEndpoint = {
      pipeName: "\\\\.\\pipe\\luckytoken-first-owner",
      capability: "first-owner-capability-012345678901234567890",
    };
    const secondEndpoint = {
      pipeName: "\\\\.\\pipe\\luckytoken-second-owner",
      capability: "second-owner-capability-01234567890123456789",
    };
    const first = await publishControlPlaneDescriptor({
      path,
      endpoint: firstEndpoint,
      createTemporaryId: () => "first",
    });
    let second: ControlPlaneDescriptorLease | undefined;

    try {
      const secondFailure = await publishControlPlaneDescriptor({
        path,
        endpoint: secondEndpoint,
        createTemporaryId: () => "second",
      }).then(
        (lease) => {
          second = lease;
          return undefined;
        },
        (error: unknown) => error,
      );

      expect(secondFailure).toMatchObject({
        code: "CONTROL_PLANE_DESCRIPTOR_OWNED",
      });
      expect(String(secondFailure)).not.toContain(secondEndpoint.capability);
      await expect(readControlPlaneDescriptor(path)).resolves.toEqual(
        firstEndpoint,
      );
      expect(await readFile(path, "utf8")).not.toContain(
        secondEndpoint.capability,
      );
    } finally {
      await second?.close();
      await first.close();
    }

    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
