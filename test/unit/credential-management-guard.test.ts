import { describe, expect, it } from "vitest";

import {
  CredentialManagementBusyError,
  CredentialManagementCancelledError,
  createCredentialManagementGuard,
} from "../../src/credentials/management.js";

describe("Global Credential Management Guard", () => {
  it("fails fast globally and exposes the active operation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guard = createCredentialManagementGuard({
      createId: () => "operation-a",
      now: () => 100,
      defaultDeadlineMs: 10_000,
    });

    const first = guard.run(
      { kind: "acquire_oauth", providerId: "provider-a" },
      async () => {
        await gate;
        return "done";
      },
    );
    await Promise.resolve();

    await expect(
      guard.run(
        { kind: "remove", providerId: "provider-b" },
        async () => "unexpected",
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "management_operation_in_progress",
        activeOperation: {
          operationId: "operation-a",
          kind: "acquire_oauth",
          providerId: "provider-a",
          startedAt: 100,
        },
      }),
    );

    release();
    await expect(first).resolves.toBe("done");
  });

  it("cancels the active operation and releases the guard in finally", async () => {
    let nextId = 0;
    const guard = createCredentialManagementGuard({
      createId: () => "operation-" + String(++nextId),
      defaultDeadlineMs: 10_000,
    });

    const first = guard.run(
      { kind: "acquire_oauth", providerId: "provider-a" },
      async (signal, operationId) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
          expect(operationId).toBe("operation-1");
        }),
    );
    await Promise.resolve();

    expect(guard.cancel("operation-1")).toBe(true);
    await expect(first).rejects.toBeInstanceOf(
      CredentialManagementCancelledError,
    );

    await expect(
      guard.run(
        { kind: "remove", providerId: "provider-b" },
        async () => "next",
      ),
    ).resolves.toBe("next");
  });

  it("releases after operation failure", async () => {
    let nextId = 0;
    const guard = createCredentialManagementGuard({
      createId: () => "operation-" + String(++nextId),
      defaultDeadlineMs: 10_000,
    });

    await expect(
      guard.run(
        { kind: "update_metadata", providerId: "provider-a" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    await expect(
      guard.run(
        { kind: "activate", providerId: "provider-b" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
  });

  it("aborts on the caller signal and releases the guard", async () => {
    const caller = new AbortController();
    const guard = createCredentialManagementGuard({
      createId: () => "operation-caller",
      defaultDeadlineMs: 10_000,
    });

    const run = guard.run(
      {
        kind: "acquire_oauth",
        providerId: "provider-a",
        signal: caller.signal,
      },
      async (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    await Promise.resolve();

    caller.abort(new Error("connection lost"));
    await expect(run).rejects.toThrow("connection lost");
    await expect(
      guard.run(
        { kind: "remove", providerId: "provider-a" },
        async () => "next",
      ),
    ).resolves.toBe("next");
  });

  it("enforces the deadline and releases the guard", async () => {
    const guard = createCredentialManagementGuard({
      createId: () => "operation-timeout",
      defaultDeadlineMs: 20,
    });

    const run = guard.run(
      { kind: "acquire_oauth", providerId: "provider-a" },
      async (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    await expect(run).rejects.toBeDefined();
    await expect(
      guard.run(
        { kind: "remove", providerId: "provider-a" },
        async () => "next",
      ),
    ).resolves.toBe("next");
  });

  it("does not cancel an unknown operation", async () => {
    const guard = createCredentialManagementGuard({
      createId: () => "operation-live",
      defaultDeadlineMs: 10_000,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = guard.run(
      { kind: "remove", providerId: "provider-a" },
      async () => {
        await gate;
        return "done";
      },
    );
    await Promise.resolve();

    expect(guard.cancel("operation-other")).toBe(false);
    release();
    await expect(run).resolves.toBe("done");
  });

  it("surfaces the typed busy error", () => {
    const error = new CredentialManagementBusyError({
      operationId: "operation-a",
      kind: "remove",
      providerId: "provider-a",
      startedAt: 1,
    });
    expect(error.code).toBe("management_operation_in_progress");
  });
});
