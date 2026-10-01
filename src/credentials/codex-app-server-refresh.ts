import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createKeyedSingleFlight } from "./keyed-single-flight.js";

import {
  codexCliInvocation,
  discoverCodexCommands,
  type CodexRuntimeDiscoveryOptions,
} from "../integrations/codex/runtime-discovery.js";

/**
 * Codex-native, in-place external credential refresh.
 *
 * Token starts one bounded one-shot `codex app-server` against the same
 * `CODEX_HOME`, performs the initialize handshake, calls
 * `account/read {"refreshToken": true}`, and terminates. Token never uses the
 * refresh token itself and never hands a near-expiry external credential to
 * Pi. RPC success is not refresh success: the caller re-reads and verifies the
 * file after this returns.
 */

export const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS = 15_000 as const;
export const CODEX_APP_SERVER_ACCOUNT_READ_TIMEOUT_MS = 30_000 as const;
const EXIT_TIMEOUT_MS = 5_000;
const MAX_PROTOCOL_BUFFER_BYTES = 4 * 1_024 * 1_024;

export type CodexRefreshDelegationOutcome =
  | { readonly outcome: "completed" }
  | {
      readonly outcome: "unavailable";
      readonly reason: "no_runtime" | "spawn_failed" | "protocol" | "timeout";
    };

export interface CodexAppServerRefresher {
  /** Exactly one run per canonical path; waiters join the same run. Waiters
   * that abort stop waiting without aborting the run other waiters need. */
  refresh(input: {
    readonly canonicalPath: string;
    readonly signal?: AbortSignal;
  }): Promise<CodexRefreshDelegationOutcome>;
  /** Diagnostics-only: number of in-flight delegation runs. */
  inflightCount(): number;
}

export interface CreateCodexAppServerRefresherOptions
  extends CodexRuntimeDiscoveryOptions {
  readonly codexHome: string;
  readonly initializeTimeoutMs?: number;
  readonly accountReadTimeoutMs?: number;
  readonly exitTimeoutMs?: number;
  /** Test seam; production uses node:child_process.spawn. */
  readonly spawnProcess?: (
    file: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly windowsHide: boolean },
  ) => ChildProcessWithoutNullStreams;
}

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

function parseRpcLine(line: string): JsonRpcResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("id" in parsed) ||
    typeof (parsed as { readonly id?: unknown }).id !== "number"
  ) {
    return undefined;
  }
  const record = parsed as { readonly id: number; readonly result?: unknown; readonly error?: unknown };
  return Object.freeze({ id: record.id, result: record.result, error: record.error });
}

function echoedCodexHome(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }
  const value = (result as { readonly codexHome?: unknown }).codexHome;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

/**
 * One-shot JSON-RPC exchange against `codex app-server`. Resolves with
 * `completed` when the account/read response for id 2 arrived; the caller must
 * still re-read and verify the document.
 */
async function runOneShot(
  command: string,
  options: {
    readonly codexHome: string;
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly initializeTimeoutMs: number;
    readonly accountReadTimeoutMs: number;
    readonly exitTimeoutMs: number;
    readonly spawnProcess: NonNullable<
      CreateCodexAppServerRefresherOptions["spawnProcess"]
    >;
  },
): Promise<CodexRefreshDelegationOutcome> {
  const invocation = codexCliInvocation(command, ["app-server"], options.platform, options.env);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = options.spawnProcess(invocation.file, invocation.args, {
      cwd: options.codexHome,
      env: { ...options.env, CODEX_HOME: options.codexHome },
      windowsHide: true,
    });
  } catch {
    return Object.freeze({ outcome: "unavailable", reason: "spawn_failed" });
  }

  const responses = new Map<number, JsonRpcResponse>();
  const waiters = new Map<number, () => void>();
  let buffer = "";
  let protocolFailure = false;
  let exited = false;

  const notify = (id: number): void => {
    const waiter = waiters.get(id);
    if (waiter !== undefined) {
      waiters.delete(id);
      waiter();
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_PROTOCOL_BUFFER_BYTES) {
      protocolFailure = true;
      notify(1);
      notify(2);
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const response = parseRpcLine(line);
      if (response === undefined) continue;
      responses.set(response.id, response);
      notify(response.id);
    }
  });
  // The app-server writes diagnostics on stderr; they are never parsed for
  // classification (evidence: no structured terminal signal exists).
  child.stderr.on("data", () => undefined);
  child.on("error", () => {
    protocolFailure = true;
    notify(1);
    notify(2);
  });
  child.on("exit", () => {
    exited = true;
    notify(1);
    notify(2);
  });

  const waitForResponse = async (
    id: number,
    timeoutMs: number,
  ): Promise<JsonRpcResponse | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = responses.get(id);
      if (response !== undefined) return response;
      if (protocolFailure || exited) return undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await Promise.race([
        new Promise<void>((resolveWait) => {
          waiters.set(id, resolveWait);
        }),
        wait(Math.min(remaining, 250)),
      ]);
    }
  };

  const result: CodexRefreshDelegationOutcome = await (async () => {
    try {
      child.stdin.write(
        `${JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "token-external-auth-refresh",
              title: "Token external auth refresh",
              version: "0.0.0",
            },
          },
        })}\n`,
      );
      const initialized = await waitForResponse(1, options.initializeTimeoutMs);
      if (initialized === undefined || protocolFailure) {
        return Object.freeze({ outcome: "unavailable", reason: "timeout" as const });
      }
      if (initialized.error !== undefined) {
        return Object.freeze({ outcome: "unavailable", reason: "protocol" as const });
      }
      const home = echoedCodexHome(initialized.result);
      if (home === undefined || !samePath(home, options.codexHome)) {
        return Object.freeze({ outcome: "unavailable", reason: "protocol" as const });
      }
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      child.stdin.write(
        `${JSON.stringify({
          id: 2,
          method: "account/read",
          params: { refreshToken: true },
        })}\n`,
      );
      const account = await waitForResponse(2, options.accountReadTimeoutMs);
      if (account === undefined) {
        return Object.freeze({ outcome: "unavailable", reason: "timeout" as const });
      }
      // The RPC result does not distinguish success classes; the caller
      // re-reads and verifies the document.
      return Object.freeze({ outcome: "completed" as const });
    } catch {
      return Object.freeze({ outcome: "unavailable", reason: "protocol" as const });
    } finally {
      try {
        child.stdin.end();
      } catch {
        // The child may already have exited.
      }
      const exitDeadline = Date.now() + options.exitTimeoutMs;
      while (!exited && Date.now() < exitDeadline) {
        await wait(50);
      }
      if (!exited) {
        try {
          child.kill();
        } catch {
          // Best effort; the process is already terminating.
        }
      }
    }
  })();

  return result;
}

export function createCodexAppServerRefresher(
  options: CreateCodexAppServerRefresherOptions,
): CodexAppServerRefresher {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const initializeTimeoutMs =
    options.initializeTimeoutMs ?? CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS;
  const accountReadTimeoutMs =
    options.accountReadTimeoutMs ?? CODEX_APP_SERVER_ACCOUNT_READ_TIMEOUT_MS;
  const exitTimeoutMs = options.exitTimeoutMs ?? EXIT_TIMEOUT_MS;
  const discover = options.discoverCommands ?? (() => discoverCodexCommands(options));
  const spawnProcess =
    options.spawnProcess ??
    ((file, args, spawnOptions) =>
      spawn(file, [...args], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        windowsHide: spawnOptions.windowsHide,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: undefined,
      }) as ChildProcessWithoutNullStreams);

  const inflight = createKeyedSingleFlight<CodexRefreshDelegationOutcome>();

  const run = async (): Promise<CodexRefreshDelegationOutcome> => {
    const commands = await discover().catch(() => Object.freeze([]));
    let lastFailure: CodexRefreshDelegationOutcome = Object.freeze({
      outcome: "unavailable",
      reason: "no_runtime",
    });
    for (const command of commands) {
      const outcome = await runOneShot(command, {
        codexHome: options.codexHome,
        platform,
        env,
        initializeTimeoutMs,
        accountReadTimeoutMs,
        exitTimeoutMs,
        spawnProcess,
      });
      if (outcome.outcome === "completed") return outcome;
      lastFailure = outcome;
      if (outcome.reason === "spawn_failed" || outcome.reason === "protocol") {
        break;
      }
    }
    return lastFailure;
  };

  return Object.freeze({
    inflightCount(): number {
      return inflight.size();
    },
    async refresh(input: {
      readonly canonicalPath: string;
      readonly signal?: AbortSignal;
    }): Promise<CodexRefreshDelegationOutcome> {
      try {
        return await inflight.run(input.canonicalPath, run, input.signal);
      } catch {
        return Object.freeze({ outcome: "unavailable",
          reason: input.signal?.aborted === true ? "timeout" : "spawn_failed" });
      }
    },
  });
}
