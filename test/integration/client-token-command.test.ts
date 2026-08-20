import { describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

describe("Control Plane client access contract", () => {
  it("does not expose a client-token command surface", async () => {
    const transport = createNodePipeTransport();
    const host = await startControlPlane({
      endpoint: {
        address: `\\\\.\\pipe\\luckytoken-no-client-token-${process.pid}`,
        capability: "no-client-token-capability-0123456789012345",
      },
      application: { id: "luckytoken", version: "test" },
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
        await client.hello(1);
        expect("executeClientTokenCommand" in client).toBe(false);
      } finally {
        await client.close();
      }
    } finally {
      await host.close();
    }
  });
});
