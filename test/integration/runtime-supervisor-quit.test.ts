import { describe, expect, it } from "vitest";

import type { ApplicationStatus } from "@token/application-control-plane/control-plane";

import {
  createDataPlaneRuntimeSupervisor,
  type RunningDataPlaneListener,
} from "../../src/runtime-supervisor.js";

describe("Data Plane supervisor quit lifecycle", () => {
  it("drains the active listener and publishes stopping then stopped", async () => {
    let drained = 0;
    let closed = 0;
    const listener: RunningDataPlaneListener = {
      close: async () => {
        closed += 1;
      },
      drain: async () => {
        drained += 1;
        return "drained";
      },
    };
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48780,
      readProvider: () => "unconfigured",
      startListener: async () => listener,
    });
    const published: ApplicationStatus[] = [];
    const publish = async (status: ApplicationStatus) => {
      published.push(status);
    };

    await supervisor.execute("start", publish);
    const outcome = await supervisor.quit({
      timeoutMs: 250,
      publishStatus: publish,
    });

    expect(outcome).toBe("drained");
    expect({ drained, closed }).toEqual({ drained: 1, closed: 0 });
    expect(published.map((status) => status.modelDataPlane)).toEqual([
      "starting",
      "running",
      "stopping",
      "stopped",
    ]);
  });

  it("reports the typed timeout outcome after the configured drain timeout", async () => {
    let drained = 0;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48781,
      readProvider: () => "unconfigured",
      startListener: async () => ({
        close: async () => undefined,
        drain: async () => {
          drained += 1;
          return "timed_out";
        },
      }),
    });
    const states: string[] = [];
    const publish = async (status: ApplicationStatus) => {
      states.push(status.modelDataPlane);
    };

    await supervisor.execute("start", publish);
    const outcome = await supervisor.quit({
      timeoutMs: 100,
      publishStatus: publish,
    });

    expect(outcome).toBe("timed_out");
    expect(drained).toBe(1);
    expect(states).toEqual(["starting", "running", "stopping", "stopped"]);
  });

  it("quits without touching a stopped listener", async () => {
    let drained = 0;
    let closed = 0;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48782,
      readProvider: () => "unconfigured",
      startListener: async () => ({
        close: async () => {
          closed += 1;
        },
        drain: async () => {
          drained += 1;
          return "drained";
        },
      }),
    });
    const states: string[] = [];
    const publish = async (status: ApplicationStatus) => {
      states.push(status.modelDataPlane);
    };

    const outcome = await supervisor.quit({
      timeoutMs: 100,
      publishStatus: publish,
    });

    expect(outcome).toBe("drained");
    expect({ drained, closed }).toEqual({ drained: 0, closed: 0 });
    expect(states).toEqual([]);
  });

  it("falls back to the listener close for listeners without a drain seam", async () => {
    let closed = 0;
    const supervisor = createDataPlaneRuntimeSupervisor({
      host: "127.0.0.1",
      port: 48783,
      readProvider: () => "unconfigured",
      startListener: async () => ({
        close: async () => {
          closed += 1;
        },
      }),
    });
    const publish = async () => undefined;

    await supervisor.execute("start", publish);
    const outcome = await supervisor.quit({
      timeoutMs: 100,
      publishStatus: publish,
    });

    expect(outcome).toBe("drained");
    expect(closed).toBe(1);
  });
});
