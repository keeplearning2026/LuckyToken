import type {
  ProviderProfileAuthCommandHandler,
  ProviderProfileAuthCommandResult,
} from "@token/application-control-plane/control-plane";
import { describe, expect, it, vi } from "vitest";

import { createAutomaticLocalLogin } from "../../src/credentials/automatic-local-login.js";

function result(outcome: ProviderProfileAuthCommandResult["outcome"] = "ok"): ProviderProfileAuthCommandResult {
  return {
    outcome,
    state: { providers: [] },
    options: { providers: [
      { providerId: "api-only", name: "API only", source: "user", acquisitionOptions: [] },
      { providerId: "connected", name: "Connected", source: "user", acquisitionOptions: [
        { kind: "local_oauth", label: "Local", icon: "terminal", authType: "oauth", interactive: true, state: "already_connected" },
      ] },
      ...["first", "second"].map((providerId) => ({
        providerId, name: providerId === "first" ? "First Provider" : "Second Provider",
        source: "user" as const, acquisitionOptions: [
          { kind: "local_oauth" as const, label: "Local", icon: "terminal" as const, authType: "oauth" as const, interactive: true, state: "available" as const },
        ],
      })),
    ] },
  };
}

describe("automatic local login through the public auth command seam", () => {
  it("records bootstrap policy and starts only after initialization", async () => {
    const auth = vi.fn<ProviderProfileAuthCommandHandler>().mockResolvedValue(result());
    const automatic = createAutomaticLocalLogin({ auth });
    automatic.setEnabled(true);
    await Promise.resolve();
    expect(auth).not.toHaveBeenCalled();
    // An enable followed by disable during bootstrap must not leak a batch.
    automatic.setEnabled(false);
    automatic.start();
    await Promise.resolve();
    expect(auth).not.toHaveBeenCalled();
    automatic.setEnabled(true);
    try {
      await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(3));
      automatic.start();
      expect(auth).toHaveBeenCalledTimes(3);
    } finally { await automatic.close(); }
  });

  it("does not wait for a pending result reporter before the next login or close", async () => {
    const auth = vi.fn<ProviderProfileAuthCommandHandler>().mockResolvedValue(result());
    const report = vi.fn(() => new Promise<void>(() => undefined));
    const automatic = createAutomaticLocalLogin({ auth, onResult: report });
    automatic.setEnabled(true);
    automatic.start();
    try {
      await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(3));
      await automatic.close();
      expect(report).toHaveBeenCalledTimes(2);
    } finally { await automatic.close(); }
  });

  it("starts only when enabled, filters capabilities, names Profiles and continues after failure", async () => {
    const calls: Parameters<ProviderProfileAuthCommandHandler>[0][] = [];
    const reports = vi.fn(() => { throw new Error("Reporting is unavailable"); });
    const auth: ProviderProfileAuthCommandHandler = async (command) => {
      calls.push(command);
      if (command.command === "login" && command.providerId === "first") throw new Error("Private failure");
      return result();
    };
    const automatic = createAutomaticLocalLogin({ auth, onResult: reports });
    automatic.start();
    expect(calls).toEqual([]);
    automatic.setEnabled(false);
    automatic.setEnabled(true);
    automatic.setEnabled(true);
    try {
      await vi.waitFor(() => expect(reports).toHaveBeenCalledTimes(2));
      expect(calls).toEqual([
        { command: "query" },
        { command: "login", providerId: "first", acquisitionKind: "local_oauth", displayName: "First Provider local login" },
        { command: "login", providerId: "second", acquisitionKind: "local_oauth", displayName: "Second Provider local login" },
      ]);
      expect(reports.mock.calls).toEqual([
        [{ providerId: "first", outcome: "failed" }],
        [{ providerId: "second", outcome: "ok" }],
      ]);
      expect(JSON.stringify(reports.mock.calls)).not.toContain("Private failure");
    } finally { await automatic.close(); }
    automatic.setEnabled(true);
    expect(calls).toHaveLength(3);
  });

  it("cancels on disable and serializes a rapid re-enable behind the old operation", async () => {
    const signals: AbortSignal[] = [];
    let finishFirst: (() => void) | undefined;
    let queryCount = 0;
    const auth: ProviderProfileAuthCommandHandler = async (command, interaction) => {
      if (command.command === "query") { queryCount += 1; return result(); }
      signals.push(interaction.signal);
      if (signals.length === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
      return result(interaction.signal.aborted ? "cancelled" : "ok");
    };
    const automatic = createAutomaticLocalLogin({ auth });
    automatic.start();
    try {
      automatic.setEnabled(true);
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      automatic.setEnabled(false);
      expect(signals[0]?.aborted).toBe(true);
      automatic.setEnabled(true);
      await Promise.resolve();
      expect(queryCount).toBe(1);
      finishFirst!();
      await vi.waitFor(() => expect(signals).toHaveLength(3));
      expect(queryCount).toBe(2);
      expect(signals.slice(1).every((signal) => !signal.aborted)).toBe(true);
    } finally { finishFirst?.(); await automatic.close(); }
  });

  it("cancels on shutdown and does not start another Provider", async () => {
    let signal: AbortSignal | undefined;
    const auth: ProviderProfileAuthCommandHandler = async (command, interaction) => {
      if (command.command === "query") return result();
      signal = interaction.signal;
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return result("cancelled");
    };
    const automatic = createAutomaticLocalLogin({ auth });
    automatic.start();
    automatic.setEnabled(true);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await automatic.close();
    expect(signal?.aborted).toBe(true);
  });

  it("reports query failure without attempting any login or leaking exception text", async () => {
    const auth = vi.fn<ProviderProfileAuthCommandHandler>().mockRejectedValue(new Error("Private query contents"));
    const reports = vi.fn();
    const automatic = createAutomaticLocalLogin({ auth, onResult: reports });
    automatic.start();
    automatic.setEnabled(true);
    try {
      await vi.waitFor(() => expect(reports).toHaveBeenCalledWith({ outcome: "failed" }));
      expect(auth).toHaveBeenCalledTimes(1);
    } finally { await automatic.close(); }
  });
});
