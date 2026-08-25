import { describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
} from "@token/application-control-plane/control-plane";

describe("Control Plane client access contract", () => {
  it("does not expose a client-token command surface", async () => {
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\Token-no-client-token-${process.pid}`,
        capability: "no-client-token-capability-0123456789012345",
      },
      application: { id: "Token", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
    });

    try {
      let requestId = 0;
      const client = await connectControlPlane(host.endpoint, {
        createRequestId: () => `no-client-token-${++requestId}`,
        pipeConnector: transport,
      });
      try {
        await client.hello(4);
        expect("executeClientTokenCommand" in client).toBe(false);
      } finally {
        await client.close();
      }
    } finally {
      await host.close();
    }
  });
});
