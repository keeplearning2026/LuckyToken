import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  connectControlPlane,
  createNodePipeTransport,
  nodePipeFallbackAccess,
  startControlPlane,
  type ControlPlaneEndpoint,
  type RunningControlPlane,
} from "@luckytoken/application-control-plane/control-plane";

import { createPublicModelAuthority } from "../../src/public-models/authority.js";
import { createPublicModelsControlPlaneHandler } from "../../src/public-models/control-plane.js";

interface Fixture {
  readonly host: RunningControlPlane;
  readonly client: Awaited<ReturnType<typeof connectControlPlane>>;
  readonly close: () => Promise<void>;
}

const fixtures: Fixture[] = [];
let nextPipe = 0;
let nextRequest = 0;

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "luckytoken-public-model-plane-"));
  const authority = createPublicModelAuthority({
    path: join(root, "public-models.json"),
    initialEndpoint: { host: "127.0.0.1", port: 3000 },
  });
  await authority.reconcile({
    version: 1,
    providers: [
      { providerId: "openai", usable: true, models: ["gpt-4o", "gpt-4.1"] },
    ],
  });
  const endpoint: ControlPlaneEndpoint = {
    address: `\\\\.\\pipe\\luckytoken-public-model-plane-${process.pid}-${++nextPipe}`,
    capability: "public-model-plane-capability-01234567890123456",
  };
  const host = await startControlPlane({
    endpoint,
    application: { id: "luckytoken", version: "test" },
    initialStatus: { modelDataPlane: "stopped", provider: "configured" },
    publicModelsCommandHandler: createPublicModelsControlPlaneHandler(authority),
    pipeServerFactory: createNodePipeTransport(),
    access: nodePipeFallbackAccess,
  });
  const client = await connectControlPlane(host.endpoint, {
    createRequestId: () => `public-model-plane-request-${++nextRequest}`,
    pipeConnector: createNodePipeTransport(),
  });
  const hello = await client.hello(4);
  if (hello.type !== "compatible") throw new Error("Control Plane hello failed");
  const fixture: Fixture = {
    host,
    client,
    close: async () => rm(root, { recursive: true, force: true }),
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      await fixture.client.close().catch(() => undefined);
      await fixture.host.close();
      await fixture.close();
    }),
  );
});

describe("Public Models commands through the Control Plane", () => {
  it("queries and mutates the one live Public Model authority", async () => {
    const fixture = await createFixture();
    const queried = await fixture.client.executePublicModelsCommand({ command: "query" });
    expect(queried.outcome).toBe("ok");
    expect(queried.state.endpoint).toEqual({ host: "127.0.0.1", port: 3000 });
    expect(queried.state.providers[0]?.models[0]).toMatchObject({
      alias: "openai/gpt-4o",
      target: "gpt-4o",
      on: true,
    });

    const modelOff = await fixture.client.executePublicModelsCommand({
      command: "set_model",
      revision: queried.state.revision,
      providerId: "openai",
      modelId: "gpt-4o",
      on: false,
    });
    expect(modelOff.outcome).toBe("ok");
    expect(modelOff.state.providers[0]?.models[0]?.on).toBe(false);

    const port = await fixture.client.executePublicModelsCommand({
      command: "set_port",
      revision: modelOff.state.revision,
      port: 4317,
    });
    expect(port.outcome).toBe("ok");
    expect(port.state.endpoint.port).toBe(4317);
  });

  it("persists a complete model order through the typed Control Plane command", async () => {
    const fixture = await createFixture();
    const queried = await fixture.client.executePublicModelsCommand({ command: "query" });

    const reordered = await fixture.client.executePublicModelsCommand({
      command: "reorder_models",
      revision: queried.state.revision,
      providerId: "openai",
      modelIds: ["gpt-4.1", "gpt-4o"],
    });

    expect(reordered.outcome).toBe("ok");
    expect(
      reordered.state.providers[0]?.models.map((model) => model.target),
    ).toEqual(["gpt-4.1", "gpt-4o"]);
  });
});
