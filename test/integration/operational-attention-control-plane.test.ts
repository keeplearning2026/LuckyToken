import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type AttentionProjection,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

let nextId = 0;
function endpoint(): ControlPlaneEndpoint {
  nextId += 1;
  return {
    pipeName: `\\\\.\\pipe\\luckytoken-t25-attention-${process.pid}-${nextId}`,
    capability: `ticket-25-attention-capability-${String(nextId).padStart(20, "0")}`,
  };
}

describe("Ticket 25 attention projection through the Control Plane", () => {
  const hosts: RunningControlPlane[] = [];
  const transport = createNodePipeTransport();
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  it("carries only the typed active conditions and request-failure aggregate", async () => {
    const target = endpoint();
    let attention: AttentionProjection | undefined = {
      conditions: [
        {
          id: "port-conflict",
          category: "port-conflict",
          since: 123,
          page: "dashboard",
        },
      ],
      requestFailures: { count: 3, windowMs: 3_600_000 },
    };
    const host = await startControlPlane({
      endpoint: target,
      application: { id: "luckytoken", version: "test" },
      initialStatus: { modelDataPlane: "stopped", provider: "unconfigured" },
      pipeServerFactory: transport,
      access: nodePipeFallbackAccess,
      attentionProjection: () => attention,
    });
    hosts.push(host);
    const client = await connectControlPlane(target, {
      createRequestId: () => `attention-request-${nextId}`,
      pipeConnector: transport,
    });
    await client.hello(1);
    await expect(client.getStatus()).resolves.toMatchObject({ attention });

    attention = undefined;
    await host.publishStatus({
      modelDataPlane: "running",
      provider: "configured",
    });
    await expect(client.getStatus()).resolves.not.toHaveProperty("attention");
    await client.close();
  });
});
