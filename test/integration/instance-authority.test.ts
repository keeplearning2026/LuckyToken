import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createInstanceAuthority,
  InstanceAuthorityOwnedError,
  resolveBackendInstanceDatabasePath,
} from "../../src/instance-authority.js";

async function fixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-instance-authority-"));
  return join(directory, "instance.sqlite");
}

describe("InstanceAuthority", () => {
  it("derives one private Backend instance database from application-owned user state", () => {
    expect(
      resolveBackendInstanceDatabasePath({ homeDirectory: "C:\\Users\\Alice" }),
    ).toBe(join("C:\\Users\\Alice", ".luckytoken", "instance.sqlite"));
  });

  it("allows exactly one authority for the same Backend instance location", async () => {
    const path = await fixturePath();
    const first = createInstanceAuthority({ path });
    const second = createInstanceAuthority({ path });
    const lease = await first.acquire();
    try {
      await expect(second.acquire()).rejects.toBeInstanceOf(InstanceAuthorityOwnedError);
    } finally {
      await lease.close();
    }
  });

  it("releases authority on close without deleting the SQLite lock carrier", async () => {
    const path = await fixturePath();
    const first = createInstanceAuthority({ path });
    const firstLease = await first.acquire();
    await firstLease.close();
    await stat(path);

    const secondAuthority = createInstanceAuthority({ path });
    const secondLease = await secondAuthority.acquire();
    try {
      // A stale cleanup from the previous lease is an idempotent no-op and
      // cannot release or damage the new owner's process-lifetime lock.
      await firstLease.close();
      await expect(createInstanceAuthority({ path }).acquire()).rejects.toBeInstanceOf(
        InstanceAuthorityOwnedError,
      );
    } finally {
      await secondLease.close();
    }
    await stat(path);
  });
});
