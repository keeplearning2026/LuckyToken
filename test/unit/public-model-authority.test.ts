import { describe, expect, it } from "vitest";

import {
  createPublicModelAuthority,
  type PublicModelFileSystem,
  type PublicModelRuntimeFacts,
} from "../../src/public-models/authority.js";

function memoryFileSystem(initial?: Record<string, string>): {
  readonly fileSystem: PublicModelFileSystem;
  readonly files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const fileSystem: PublicModelFileSystem = {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    rename: async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      files.delete(from);
      files.set(to, content);
    },
    mkdir: async () => undefined,
    rm: async (path: string) => {
      files.delete(path);
    },
  };
  return { fileSystem, files };
}

const path = "C:\\app\\public-models.json";
const endpoint = Object.freeze({ host: "127.0.0.1", port: 3000 });

const runtime: PublicModelRuntimeFacts = {
  version: 1,
  providers: [
    {
      providerId: "anthropic",
      usable: true,
      models: ["claude/opus", "claude/sonnet"],
    },
  ],
};

describe("PublicModelAuthority", () => {
  it("owns the local endpoint and makes a port command durable before ok", async () => {
    let writes = 0;
    const memory = memoryFileSystem();
    const fileSystem: PublicModelFileSystem = {
      ...memory.fileSystem,
      writeFile: async (filePath, content) => {
        writes += 1;
        await memory.fileSystem.writeFile(filePath, content);
      },
    };
    const authority = createPublicModelAuthority({
      path,
      fileSystem,
      initialEndpoint: endpoint,
    });
    const ready = await authority.reconcile({ version: 1, providers: [] });

    expect(ready.snapshot.endpoint).toEqual(endpoint);
    const changed = await authority.setPort({
      revision: ready.revision,
      port: 4321,
    });

    expect(changed.outcome).toBe("ok");
    expect(changed.state.snapshot.endpoint).toEqual({
      host: "127.0.0.1",
      port: 4321,
    });
    expect(writes).toBe(1);

    await authority.flush();
    expect(writes).toBe(1);
    expect(JSON.parse(memory.files.get(path) ?? "null").endpoint).toEqual({
      host: "127.0.0.1",
      port: 4321,
    });
  });

  it("makes an explicit model switch durable while leaving reconcile debounce separate", async () => {
    let writes = 0;
    let scheduled: (() => void) | undefined;
    const initial = {
      schemaVersion: 1,
      endpoint,
      providers: {
        anthropic: {
          enabled: true,
          models: {
            "anthropic/claude-opus": { target: "claude/opus", enabled: true },
          },
        },
      },
    };
    const memory = memoryFileSystem({
      [path]: `${JSON.stringify(initial, null, 2)}\n`,
    });
    const fileSystem: PublicModelFileSystem = {
      ...memory.fileSystem,
      writeFile: async (filePath, content) => {
        writes += 1;
        await memory.fileSystem.writeFile(filePath, content);
      },
    };
    const authority = createPublicModelAuthority({
      path,
      fileSystem,
      persistence: {
        delayMs: 1_000,
        schedule: (task) => {
          scheduled = task;
          return () => {
            scheduled = undefined;
          };
        },
      },
    });
    const ready = await authority.reconcile({
      version: 1,
      providers: [
        { providerId: "anthropic", usable: true, models: ["claude/opus"] },
      ],
    });

    const result = await authority.setModelOn({
      revision: ready.revision,
      providerId: "anthropic",
      modelId: "claude/opus",
      on: false,
    });

    expect(result.outcome).toBe("ok");
    expect(result.state.snapshot.providers[0]?.models[0]?.on).toBe(false);
    expect(writes).toBe(1);
    expect(JSON.parse(memory.files.get(path) ?? "null").providers.anthropic.models[
      "anthropic/claude-opus"
    ].enabled).toBe(false);

    scheduled?.();
    await authority.flush();

    expect(writes).toBe(1);
    expect(JSON.parse(memory.files.get(path) ?? "null").providers.anthropic.models[
      "anthropic/claude-opus"
    ].enabled).toBe(false);
  });

  it("does not bump the Public snapshot version for a Catalog-only version change", async () => {
    const { fileSystem } = memoryFileSystem();
    const authority = createPublicModelAuthority({ path, fileSystem });
    const first = await authority.reconcile(runtime);

    const second = await authority.reconcile({ ...runtime, version: 99 });

    expect(second.snapshot.version).toBe(first.snapshot.version);
  });

  it("materializes newly discovered providers and models once with provider/model defaults ON", async () => {
    const { fileSystem, files } = memoryFileSystem();
    const authority = createPublicModelAuthority({ path, fileSystem });

    const state = await authority.reconcile(runtime);

    expect(state.revision).toBe(1);
    expect(state.snapshot.providers).toEqual([
      {
        providerId: "anthropic",
        on: true,
        models: [
          {
            alias: "anthropic/claude-opus",
            target: "claude/opus",
            on: true,
          },
          {
            alias: "anthropic/claude-sonnet",
            target: "claude/sonnet",
            on: true,
          },
        ],
      },
    ]);
    expect(state.snapshot.publishedModels()).toEqual([
      {
        alias: "anthropic/claude-opus",
        providerId: "anthropic",
        modelId: "claude/opus",
      },
      {
        alias: "anthropic/claude-sonnet",
        providerId: "anthropic",
        modelId: "claude/sonnet",
      },
    ]);
    expect(files.has(path)).toBe(false);
    await authority.flush();
    expect(JSON.parse(files.get(path) ?? "null")).toEqual({
      schemaVersion: 1,
      endpoint,
      providers: {
        anthropic: {
          enabled: true,
          models: {
            "anthropic/claude-opus": {
              target: "claude/opus",
              enabled: true,
            },
            "anthropic/claude-sonnet": {
              target: "claude/sonnet",
              enabled: true,
            },
          },
        },
      },
    });
  });

  it("preserves existing provider/model choices, adds only new targets, and does not rewrite unchanged state", async () => {
    let writes = 0;
    const initial = {
      schemaVersion: 1,
      endpoint,
      providers: {
        anthropic: {
          enabled: false,
          models: {
            "anthropic/my-opus": { target: "claude/opus", enabled: false },
            "anthropic/old": { target: "claude/old", enabled: true },
          },
        },
      },
    };
    const memory = memoryFileSystem({
      [path]: `${JSON.stringify(initial, null, 2)}\n`,
    });
    const fileSystem: PublicModelFileSystem = {
      ...memory.fileSystem,
      writeFile: async (filePath, content) => {
        writes += 1;
        await memory.fileSystem.writeFile(filePath, content);
      },
    };
    const authority = createPublicModelAuthority({ path, fileSystem });
    const nextRuntime: PublicModelRuntimeFacts = {
      version: 2,
      providers: [
        {
          providerId: "anthropic",
          usable: true,
          models: ["claude/opus", "claude/sonnet"],
        },
      ],
    };

    const first = await authority.reconcile(nextRuntime);
    const second = await authority.reconcile(nextRuntime);

    expect(first.snapshot.providers).toEqual([
      {
        providerId: "anthropic",
        on: false,
        models: [
          { alias: "anthropic/my-opus", target: "claude/opus", on: false },
          { alias: "anthropic/old", target: "claude/old", on: true },
          {
            alias: "anthropic/claude-sonnet",
            target: "claude/sonnet",
            on: true,
          },
        ],
      },
    ]);
    expect(first.snapshot.publishedModels()).toEqual([]);
    expect(second.revision).toBe(first.revision);
    expect(writes).toBe(0);
    await authority.flush();
    expect(writes).toBe(1);
    expect(JSON.parse(memory.files.get(path) ?? "null")).toEqual({
      schemaVersion: 1,
      endpoint,
      providers: {
        anthropic: {
          enabled: false,
          models: {
            "anthropic/my-opus": { target: "claude/opus", enabled: false },
            "anthropic/old": { target: "claude/old", enabled: true },
            "anthropic/claude-sonnet": {
              target: "claude/sonnet",
              enabled: true,
            },
          },
        },
      },
    });
  });

  it("allows Provider OFF while logged out, durably, and rejects OFF to ON until login", async () => {
    let writes = 0;
    const initial = {
      schemaVersion: 1,
      endpoint,
      providers: {
        anthropic: {
          enabled: true,
          models: {
            "anthropic/claude-opus": { target: "claude/opus", enabled: true },
          },
        },
      },
    };
    const memory = memoryFileSystem({
      [path]: `${JSON.stringify(initial, null, 2)}\n`,
    });
    const fileSystem: PublicModelFileSystem = {
      ...memory.fileSystem,
      writeFile: async (filePath, content) => {
        writes += 1;
        await memory.fileSystem.writeFile(filePath, content);
      },
    };
    const authority = createPublicModelAuthority({ path, fileSystem });
    const ready = await authority.reconcile({
      version: 1,
      providers: [
        { providerId: "anthropic", usable: false, models: ["claude/opus"] },
      ],
    });

    const off = await authority.setProviderOn({
      revision: ready.revision,
      providerId: "anthropic",
      on: false,
    });
    expect(off.outcome).toBe("ok");
    expect(off.state.snapshot.providers[0]?.on).toBe(false);
    expect(writes).toBe(1);

    const rejected = await authority.setProviderOn({
      revision: off.state.revision,
      providerId: "anthropic",
      on: true,
    });
    expect(rejected.outcome).toBe("unavailable");
    expect(rejected.state.snapshot.providers[0]?.on).toBe(false);
  });

  it("turns a Provider total switch OFF atomically while preserving its model switches", async () => {
    const { fileSystem, files } = memoryFileSystem();
    const authority = createPublicModelAuthority({ path, fileSystem });
    const initial = await authority.reconcile(runtime);

    const result = await authority.setProviderOn({
      revision: initial.revision,
      providerId: "anthropic",
      on: false,
    });

    expect(result.outcome).toBe("ok");
    expect(result.state.snapshot.providers).toEqual([
      {
        providerId: "anthropic",
        on: false,
        models: [
          {
            alias: "anthropic/claude-opus",
            target: "claude/opus",
            on: true,
          },
          {
            alias: "anthropic/claude-sonnet",
            target: "claude/sonnet",
            on: true,
          },
        ],
      },
    ]);
    expect(result.state.snapshot.publishedModels()).toEqual([]);
    await authority.flush();
    expect(JSON.parse(files.get(path) ?? "null").providers.anthropic).toEqual({
      enabled: false,
      models: {
        "anthropic/claude-opus": { target: "claude/opus", enabled: true },
        "anthropic/claude-sonnet": {
          target: "claude/sonnet",
          enabled: true,
        },
      },
    });
  });

  it("allows model switches while the Provider total switch is OFF or logged out", async () => {
    const initial = {
      schemaVersion: 1,
      endpoint,
      providers: {
        anthropic: {
          enabled: false,
          models: {
            "anthropic/claude-opus": { target: "claude/opus", enabled: true },
          },
        },
      },
    };
    const { fileSystem } = memoryFileSystem({
      [path]: `${JSON.stringify(initial, null, 2)}\n`,
    });
    const authority = createPublicModelAuthority({ path, fileSystem });
    const ready = await authority.reconcile({
      version: 1,
      providers: [
        { providerId: "anthropic", usable: false, models: ["claude/opus"] },
      ],
    });

    const result = await authority.setModelOn({
      revision: ready.revision,
      providerId: "anthropic",
      modelId: "claude/opus",
      on: false,
    });

    expect(result.outcome).toBe("ok");
    expect(result.state.snapshot.providers[0]?.on).toBe(false);
    expect(result.state.snapshot.providers[0]?.models[0]?.on).toBe(false);
  });

  it("renames one model without changing target or model switch, then restores the deterministic default", async () => {
    const { fileSystem } = memoryFileSystem();
    const authority = createPublicModelAuthority({ path, fileSystem });
    const initial = await authority.reconcile(runtime);

    const renamed = await authority.renameModel({
      revision: initial.revision,
      providerId: "anthropic",
      modelId: "claude/opus",
      modelName: "my-opus",
    });

    expect(renamed.outcome).toBe("ok");
    expect(renamed.state.snapshot.resolve("anthropic/my-opus")).toEqual({
      providerId: "anthropic",
      modelId: "claude/opus",
    });
    expect(renamed.state.snapshot.resolve("anthropic/claude-opus")).toBeUndefined();
    expect(
      renamed.state.snapshot.providers[0]?.models.find(
        (model) => model.target === "claude/opus",
      ),
    ).toEqual({
      alias: "anthropic/my-opus",
      target: "claude/opus",
      on: true,
    });

    const restored = await authority.restoreModelName({
      revision: renamed.state.revision,
      providerId: "anthropic",
      modelId: "claude/opus",
    });

    expect(restored.outcome).toBe("ok");
    expect(restored.state.snapshot.resolve("anthropic/claude-opus")).toEqual({
      providerId: "anthropic",
      modelId: "claude/opus",
    });
    expect(restored.state.snapshot.resolve("anthropic/my-opus")).toBeUndefined();
  });

  it("rejects a rename outside the Provider namespace contract without changing memory", async () => {
    const { fileSystem } = memoryFileSystem();
    const authority = createPublicModelAuthority({ path, fileSystem });
    const initial = await authority.reconcile(runtime);

    const result = await authority.renameModel({
      revision: initial.revision,
      providerId: "anthropic",
      modelId: "claude/opus",
      modelName: "bad/name",
    });

    expect(result.outcome).toBe("invalid");
    expect(result.state.revision).toBe(initial.revision);
    expect(result.state.snapshot.resolve("anthropic/claude-opus")).toEqual({
      providerId: "anthropic",
      modelId: "claude/opus",
    });
  });

  it("turns a model OFF for publication without removing its alias resolution", async () => {
    const { fileSystem } = memoryFileSystem();
    const authority = createPublicModelAuthority({ path, fileSystem });
    const initial = await authority.reconcile(runtime);

    const result = await authority.setModelOn({
      revision: initial.revision,
      providerId: "anthropic",
      modelId: "claude/opus",
      on: false,
    });

    expect(result.outcome).toBe("ok");
    expect(result.state.snapshot.providers[0]?.models).toEqual([
      {
        alias: "anthropic/claude-opus",
        target: "claude/opus",
        on: false,
      },
      {
        alias: "anthropic/claude-sonnet",
        target: "claude/sonnet",
        on: true,
      },
    ]);
    expect(result.state.snapshot.publishedModels()).toEqual([
      {
        alias: "anthropic/claude-sonnet",
        providerId: "anthropic",
        modelId: "claude/sonnet",
      },
    ]);
    expect(result.state.snapshot.resolve("anthropic/claude-opus")).toEqual({
      providerId: "anthropic",
      modelId: "claude/opus",
    });
  });

  it("returns storage_failure without publishing a user mutation", async () => {
    const initial = {
      schemaVersion: 1,
      endpoint,
      providers: {},
    };
    const memory = memoryFileSystem({ [path]: JSON.stringify(initial) });
    const authority = createPublicModelAuthority({
      path,
      fileSystem: {
        ...memory.fileSystem,
        rename: async () => {
          throw new Error("disk unavailable");
        },
      },
    });
    const ready = await authority.reconcile({ version: 1, providers: [] });

    const result = await authority.setPort({ revision: ready.revision, port: 4321 });

    expect(result.outcome).toBe("storage_failure");
    expect(result.state.revision).toBe(ready.revision);
    expect(result.state.snapshot.endpoint).toEqual(endpoint);
    expect(authority.snapshot().endpoint).toEqual(endpoint);
  });

  it("persists pending reconcile materialization with the next user command", async () => {
    const memory = memoryFileSystem();
    const authority = createPublicModelAuthority({ path, fileSystem: memory.fileSystem });
    const reconciled = await authority.reconcile(runtime);

    const result = await authority.setPort({ revision: reconciled.revision, port: 4321 });

    expect(result.outcome).toBe("ok");
    const durable = JSON.parse(memory.files.get(path) ?? "null");
    expect(durable.endpoint.port).toBe(4321);
    expect(durable.providers.anthropic.models).toHaveProperty(
      "anthropic/claude-opus",
    );
  });

  it("prevents an old reconcile timer from overwriting a later user command", async () => {
    const memory = memoryFileSystem();
    let scheduled: (() => void) | undefined;
    let writes = 0;
    const authority = createPublicModelAuthority({
      path,
      fileSystem: {
        ...memory.fileSystem,
        writeFile: async (filePath, content) => {
          writes += 1;
          await memory.fileSystem.writeFile(filePath, content);
        },
      },
      persistence: {
        delayMs: 1_000,
        schedule(task) {
          scheduled = task;
          return () => undefined;
        },
      },
    });
    const reconciled = await authority.reconcile(runtime);
    const staleTimer = scheduled;
    await authority.setPort({ revision: reconciled.revision, port: 4321 });

    staleTimer?.();
    await authority.flush();
    expect(writes).toBe(1);
    expect(JSON.parse(memory.files.get(path) ?? "null").endpoint.port).toBe(4321);
  });

  it("recovers after a background flush failure and lets the next user command persist", async () => {
    const memory = memoryFileSystem();
    let renameAttempts = 0;
    let scheduled: (() => void) | undefined;
    const authority = createPublicModelAuthority({
      path,
      fileSystem: {
        ...memory.fileSystem,
        rename: async (from, to) => {
          renameAttempts += 1;
          if (renameAttempts === 1) throw new Error("background write failed");
          await memory.fileSystem.rename(from, to);
        },
      },
      persistence: {
        delayMs: 1_000,
        schedule(task) {
          scheduled = task;
          return () => undefined;
        },
      },
    });
    const reconciled = await authority.reconcile(runtime);
    scheduled?.();
    await expect.poll(() => renameAttempts).toBe(1);

    const result = await authority.setPort({ revision: reconciled.revision, port: 4321 });

    expect(result.outcome).toBe("ok");
    expect(renameAttempts).toBe(2);
    expect(JSON.parse(memory.files.get(path) ?? "null").endpoint.port).toBe(4321);
  });

  it("flushes dirty reconcile state for a no-op user command", async () => {
    const memory = memoryFileSystem();
    const authority = createPublicModelAuthority({ path, fileSystem: memory.fileSystem });
    const reconciled = await authority.reconcile(runtime);

    const result = await authority.setProviderOn({
      revision: reconciled.revision,
      providerId: "anthropic",
      on: true,
    });

    expect(result).toMatchObject({ outcome: "ok", state: { revision: reconciled.revision } });
    expect(memory.files.has(path)).toBe(true);
  });
});
