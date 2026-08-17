import { describe, expect, it } from "vitest";

import {
  connectControlPlane,
  startControlPlane,
  type ControlPlaneEndpoint,
} from "@luckytoken/application-control-plane/control-plane";

import { createProductionControlPipe } from "../../src/control-pipe-composition.js";

const windowsControlPipeAccessMask = 0x0012_019f;

let nextPipe = 0;
function endpoint(): ControlPlaneEndpoint {
  nextPipe += 1;
  return {
    address: `\\\\.\\pipe\\luckytoken-native-integration-${process.pid}-${nextPipe}`,
    capability: "native-integration-capability-01234567890123456789",
  };
}

it("keeps the acknowledged Node fallback for non-Windows hosts", async () => {
  const selected = await createProductionControlPipe({
    platform: "linux",
    architecture: "x64",
  });

  expect(selected.access).toEqual({
    mode: "node-fallback",
    acknowledgement: "node-runtime-does-not-guarantee-current-user-dacl",
  });
});

it("rejects unsupported Windows architectures before native selection", async () => {
  await expect(
    createProductionControlPipe({
      platform: "win32",
      architecture: "arm64",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED_CONTROL_PIPE_ARCHITECTURE",
    architecture: "arm64",
  });
});

describe.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "Windows production Control Pipe",
  () => {
    it("selects strict current-user access instead of the Node fallback", async () => {
      const selected = await createProductionControlPipe({
        platform: "win32",
        architecture: "x64",
      });

      expect(selected.access.mode).toBe("strict-current-user");
    });

    it("hosts the Control Plane on the inspected native pipe for ordinary Node clients", async () => {
      const selected = await createProductionControlPipe({
        platform: "win32",
        architecture: "x64",
      });
      if (selected.access.mode !== "strict-current-user") {
        throw new Error("Expected strict Windows Control Pipe access");
      }

      const rawEndpoint = endpoint();
      const rawServer = await selected.pipeServerFactory.listen(
        rawEndpoint.address,
      );
      expect(rawServer.securityPolicy()).toEqual({
        ownerSid: selected.access.ownerSid,
        daclProtected: true,
        accessMask: windowsControlPipeAccessMask,
        rejectRemoteClients: true,
      });
      const accepting = rawServer.accept();
      const rawClient = await selected.pipeConnector.connect(
        rawEndpoint.address,
      );
      const rawConnection = await accepting;
      expect(rawConnection).not.toBeNull();
      await rawClient.write(Buffer.from("native-request", "utf8"));
      await expect(rawConnection?.read(64)).resolves.toEqual(
        Buffer.from("native-request", "utf8"),
      );
      await rawConnection?.write(Buffer.from("native-response", "utf8"));
      await expect(rawClient.read(64)).resolves.toEqual(
        Buffer.from("native-response", "utf8"),
      );
      const peerEof = rawConnection?.read(1);
      await rawClient.close();
      await expect(peerEof).resolves.toBeNull();
      await rawConnection?.close();
      await rawConnection?.close();
      await rawServer.close();
      await rawServer.close();

      const target = endpoint();
      const host = await startControlPlane({
        endpoint: target,
        application: { id: "luckytoken", version: "native-test" },
        initialStatus: {
          modelDataPlane: "running",
          provider: "configured",
        },
        pipeServerFactory: selected.pipeServerFactory,
        access: selected.access,
      });
      let requestId = 0;
      const client = await connectControlPlane(target, {
        createRequestId: () => `native-request-${++requestId}`,
        pipeConnector: selected.pipeConnector,
      });
      const hello = await client.hello(1);
      expect(hello).toEqual({
        type: "compatible",
        application: { id: "luckytoken", version: "native-test" },
        contractVersion: 1,
      });
      const snapshot = await client.getStatus();
      expect(snapshot).toEqual({
        sequence: 0,
        modelDataPlane: "running",
        provider: "configured",
      });
      expect(JSON.stringify({ hello, snapshot })).not.toContain(
        target.capability,
      );

      const unauthorized = await connectControlPlane(
        {
          ...target,
          capability: "wrong-native-capability-012345678901234567890",
        },
        {
          createRequestId: () => `unauthorized-${++requestId}`,
          pipeConnector: selected.pipeConnector,
        },
      );
      const unauthorizedError = await unauthorized
        .hello(1)
        .catch((error: unknown) => error);
      expect(String(unauthorizedError)).toContain("unauthorized");
      expect(String(unauthorizedError)).not.toContain(
        "wrong-native-capability-012345678901234567890",
      );
      await unauthorized.close();

      await expect(
        Promise.race([
          host.close().then(() => "closed"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("hung"), 2_000),
          ),
        ]),
      ).resolves.toBe("closed");
      await expect(client.disconnected).resolves.toEqual({
        reason: "transport_lost",
      });
      await client.close();
    });
  },
);
