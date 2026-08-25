import { describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
} from "@token/application-control-plane/control-plane";

describe("Control Plane client-token removal contract", () => {
  it("does not expose token authority commands to a connected client", async () => {
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\Token-no-token-authority-${process.pid}`,
        capability: "no-token-authority-capability-012345678901",
      },
      application: { id: "Token", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });

    try {
      let requestId = 0;
      const client = await connectControlPlane(host.endpoint, {
        createRequestId: () => `no-token-authority-${++requestId}`,
        pipeConnector: transport,
      });
      try {
        await client.hello(4);
        expect(Object.keys(client)).not.toContain("executeClientTokenCommand");
      } finally {
        await client.close();
      }
    } finally {
      await host.close();
    }
  });
});
