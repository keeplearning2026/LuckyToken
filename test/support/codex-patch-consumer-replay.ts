import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

interface RpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
}

/** exec --json omits streaming patch updates. The same installed Codex CLI's
 * app-server exposes the actual consumer's call-id-bearing notifications. */
export async function replayCodexPatchConsumers(
  cli: string,
  cwd: string,
  codexHome: string,
): Promise<{ readonly updates: readonly Record<string, unknown>[]; readonly stderr: string }> {
  const child = spawn(process.execPath, [cli, "app-server"], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "local-production-replay-only" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const updates: Record<string, unknown>[] = [];
  const assistantMessages: string[] = [];
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 0;
  let complete!: (value: Record<string, unknown>) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
    complete = resolve;
    rejectCompletion = reject;
  });
  // A startup failure can arrive before the turn-completion promise is awaited.
  void completion.catch(() => undefined);
  const fail = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    rejectCompletion(error);
  };
  const exit = new Promise<void>((resolveExit) => child.once("close", () => {
    fail(new Error(`Codex app-server exited before replay completed: ${stderr}`));
    resolveExit();
  }));
  child.on("error", fail);
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as RpcMessage;
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        assert.ok(waiter, `Unexpected server request/response: ${line}`);
        pending.delete(message.id);
        if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result ?? {});
      } else if (message.method === "item/fileChange/patchUpdated") {
        updates.push(message.params ?? {});
      } else if (message.method === "item/completed") {
        const item = message.params?.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && item.text !== undefined) assistantMessages.push(item.text);
      } else if (message.method === "turn/completed") {
        complete(message.params ?? {});
      } else if (message.method === "error") {
        fail(new Error(`${JSON.stringify(message.params)}\n${stderr}`));
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const request = (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    return new Promise<Record<string, unknown>>((resolveRequest, reject) => {
      pending.set(id, { resolve: resolveRequest, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  const timeout = setTimeout(() => {
    fail(new Error(`Codex patch consumer replay timed out: ${stderr}`));
    child.kill();
  }, 45_000);
  try {
    await request("initialize", {
      clientInfo: { name: "token-lifecycle-replay", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const started = await request("thread/start", {
      cwd, model: "openai/gpt-native", approvalPolicy: "never",
      sandbox: "read-only", ephemeral: true,
    });
    const thread = started.thread as { id: string };
    assert.equal(typeof thread.id, "string");
    await request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Apply the two supplied patches in this temporary workspace, then finish." }],
    });
    const terminal = await completion;
    assert.equal((terminal.turn as { status: string }).status, "completed");
    assert.deepEqual(assistantMessages, ["PATCH_CONSUMERS_OK"]);
    return { updates, stderr };
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill();
    await exit;
  }
}
