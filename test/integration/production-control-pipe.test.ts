import { describe, expect, it } from "vitest";

import { createLocalIpcAddress } from "@token/application-control-plane/control-plane";
import { createProductionControlPipe } from "../../src/control-pipe-composition.js";

describe("production Control Plane local IPC composition", () => {
  it("uses the pure Node transport for both host and client", async () => {
    const transport = await createProductionControlPipe();
    expect(transport.access).toEqual({
      mode: "node-fallback",
      acknowledgement: "node-runtime-does-not-guarantee-current-user-dacl",
    });

    const address = createLocalIpcAddress({
      platform: process.platform,
      runtimeDirectory: process.cwd(),
      randomId: `production-ipc-${process.pid}-${Date.now()}`,
    });
    const server = await transport.pipeServerFactory.listen(address);
    const client = await transport.pipeConnector.connect(address);
    const accepted = await server.accept();
    expect(accepted).not.toBeNull();
    if (accepted === null) return;

    try {
      await client.write(Buffer.from("node-only", "utf8"));
      await expect(accepted.read(64)).resolves.toEqual(
        Buffer.from("node-only", "utf8"),
      );
    } finally {
      await client.close();
      await accepted.close();
      await server.close();
    }
  });
});
