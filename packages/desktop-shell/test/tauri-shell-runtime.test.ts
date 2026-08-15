import { describe, expect, it } from "vitest";

import {
  createTauriDesktopRuntime,
  type NativeTauriBridge,
} from "../src/tauri-shell-runtime.js";
import type { ControlPlaneBridgePayload } from "../src/control-plane-projection.js";

describe("Tauri shell runtime public adapter seam", () => {
  it("listens before snapshot and ignores a stale snapshot revision", async () => {
    const calls: Array<{ readonly command: string; readonly args?: unknown }> = [];
    let listener: ((event: { readonly payload: ControlPlaneBridgePayload }) => void) | undefined;
    let unlistened = 0;
    const bridge: NativeTauriBridge = {
      listen: async (event, next) => {
        expect(event).toBe("luckytoken://shell-state");
        listener = next;
        return () => {
          unlistened += 1;
        };
      },
      invoke: async (command, args) => {
        calls.push({ command, ...(args === undefined ? {} : { args }) });
        listener?.({
          payload: {
            revision: 2,
            connection: "disconnected",
            reason: "transport_lost",
            capability: "event-secret",
          },
        });
        return {
          revision: 1,
          connection: "unavailable",
          reason: "descriptor_missing",
          capability: "snapshot-secret",
        };
      },
    };
    const runtime = createTauriDesktopRuntime(bridge);

    const state = await runtime.connectControlPlane();
    await runtime.disconnectControlPlane();

    expect(state).toMatchObject({
      revision: 2,
      kind: "error",
      code: "transport_lost",
    });
    expect(calls).toEqual([{ command: "shell_snapshot" }]);
    expect(JSON.stringify(state)).not.toMatch(/capability|secret/u);
    expect(unlistened).toBe(1);
  });
});
