import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";

import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createTokenRuntime } from "../../src/runtime.js";
import { startTokenHttpServer } from "../../src/server.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";
import { replayCodexPatchConsumers } from "../support/codex-patch-consumer-replay.js";

const FORBIDDEN = [
  "OutputTextDelta without active item",
  "ReasoningSummaryDelta without active item",
  "ReasoningSummaryPartAdded without active item",
  "ReasoningRawContentDelta without active item",
] as const;

const root = await mkdtemp(join(tmpdir(), "Token-production-item-chain-replay-"));
const cli = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);

const message = (id: string, text = "", status = "completed") => ({
  type: "message",
  id,
  role: "assistant",
  status,
  content: text ? [{ type: "output_text", text, annotations: [] }] : [],
});
const reasoning = (id: string, status = "completed", summaryText = "") => ({
  type: "reasoning",
  id,
  status,
  summary: summaryText ? [{ type: "summary_text", text: summaryText }] : [],
});
const a = message("msg_a", "ANSWER_A");
const b = message("msg_b", "ANSWER_B");
const added = (item: ReturnType<typeof message>, index: number) => ({
  type: "response.output_item.added",
  output_index: index,
  item: message(item.id, "", "in_progress"),
});
const delta = (
  item: ReturnType<typeof message>,
  index: number,
  text: string,
) => ({
  type: "response.output_text.delta",
  output_index: index,
  item_id: item.id,
  content_index: 0,
  delta: text,
});
const done = (item: ReturnType<typeof message>, index: number) => ({
  type: "response.output_item.done",
  output_index: index,
  item,
});
const chainA = [added(a, 0), delta(a, 0, "ANSWER_A"), done(a, 0)] as const;
const chainB = [added(b, 1), delta(b, 1, "ANSWER_B"), done(b, 1)] as const;
const terminalFor = (output: readonly Record<string, unknown>[]) => ({
  type: "response.completed",
  response: {
    id: "resp_replay",
    object: "response",
    status: "completed",
    model: "gpt-native",
    output,
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  },
});

let wire = "";
let providerRequests = 0;
let providerResponder: ((request: Request) => Promise<Response>) | undefined;

function runCodex(
  args: readonly string[],
  cwd: string,
  codexHome: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: "local-production-replay-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), 45_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

let tokenServer: Awaited<ReturnType<typeof startTokenHttpServer>> | undefined;
try {
  const model: Model<string> = {
    id: "gpt-native",
    name: "GPT Native",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://provider.example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const models = {
    getModels: () => [model],
    getAuth: async () => ({ auth: { apiKey: "local-provider-key" } }),
  } as unknown as Models;
  const providerFetch: FetchFunction = async (input, init) => {
    providerRequests += 1;
    const request = new Request(input, init);
    if (providerResponder !== undefined) return providerResponder(request);
    return new Response(wire, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const handler = createOpenAIResponsesHandler({
    models,
    providerNativeLane: createProviderNativeResponses({
      models,
      bindings: ambientProfileBindings,
      fetch: providerFetch,
    }),
    stateFile: join(root, "responses-state.json"),
    maxRequestBytes: 1_000_000,
    createSessionId: () => "session_replay",
    createResponseId: () => "resp_unused",
    now: () => 1,
  });
  tokenServer = await startTokenHttpServer({
    runtime: createTokenRuntime({ clientProtocols: [handler] }),
    port: 0,
  });

  const versionHome = join(root, "version-home");
  await mkdir(versionHome, { recursive: true });
  const version = await runCodex(["--version"], root, versionHome);
  process.stdout.write(version.stdout.trim() + "\n");

  const cases = [
    {
      name: "overlap_index_ordered_done",
      events: [chainA[0], chainA[1], chainB[0], chainA[2], chainB[1], chainB[2]],
      finalOutput: [a, b],
      expectedFinal: "ANSWER_B",
      expectedMessages: ["ANSWER_A", "ANSWER_B"],
    },
    {
      name: "overlap_reverse_done",
      events: [chainA[0], ...chainB, chainA[1], chainA[2]],
      finalOutput: [a, b],
      expectedFinal: "ANSWER_A",
      expectedMessages: ["ANSWER_B", "ANSWER_A"],
    },
    {
      name: "overlap_global_reverse_done",
      events: [
        chainA[0],
        { type: "response.metadata", marker: "global-between" },
        ...chainB,
        chainA[1],
        chainA[2],
      ],
      finalOutput: [a, b],
      expectedFinal: "ANSWER_A",
      expectedMessages: ["ANSWER_B", "ANSWER_A"],
    },
    {
      name: "reasoning_message_overlap",
      events: [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: reasoning("rs_1", "in_progress"),
        },
        {
          type: "response.reasoning_text.delta",
          output_index: 0,
          item_id: "rs_1",
          content_index: 0,
          delta: "internal",
        },
        chainB[0],
        {
          type: "response.output_item.done",
          output_index: 0,
          item: reasoning("rs_1", "completed", "PLAN_R1"),
        },
        chainB[1],
        chainB[2],
      ],
      finalOutput: [reasoning("rs_1", "completed", "PLAN_R1"), b],
      expectedFinal: "ANSWER_B",
      expectedMessages: ["ANSWER_B"],
    },
  ] as const;

  const selectedCase = process.env.TOKEN_REPLAY_CASE;
  const selectedCases =
    selectedCase === undefined
      ? cases
      : cases.filter((testCase) => testCase.name === selectedCase);
  const runToolHistoryCase =
    selectedCase === undefined || selectedCase === "tool_history_overlap";
  const runPatchConsumerCase =
    selectedCase === undefined || selectedCase === "custom_tool_consumer_overlap";
  if (selectedCases.length === 0 && !runToolHistoryCase && !runPatchConsumerCase) {
    throw new Error(`Unknown TOKEN_REPLAY_CASE: ${selectedCase}`);
  }

  for (const testCase of selectedCases) {
    const directory = join(root, testCase.name);
    const codexHome = join(directory, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model = "openai/gpt-native"',
        'model_provider = "token_replay"',
        "[model_providers.token_replay]",
        'name = "LuckyToken production lifecycle replay"',
        `base_url = "${tokenServer.origin}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
      ].join("\n"),
    );
    const output = join(directory, "final.txt");
    wire = [
      {
        type: "response.created",
        response: {
          id: "resp_replay",
          status: "in_progress",
          model: "gpt-native",
        },
      },
      ...testCase.events,
      terminalFor(testCase.finalOutput),
    ]
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");

    const result = await runCodex(
      [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-o",
        output,
        "Reply with a short answer. Do not use tools.",
      ],
      directory,
      codexHome,
    );
    const final = await readFile(output, "utf8").catch(() => "");
    const events = result.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
          };
        } catch {
          return {};
        }
      });
    const completedMessages = events
      .filter(
        (event) =>
          event.type === "item.completed" &&
          event.item?.type === "agent_message",
      )
      .map((event) => event.item?.text ?? "");
    const forbidden = FORBIDDEN.filter((diagnostic) =>
      result.stderr.includes(diagnostic),
    );
    const summary = {
      name: testCase.name,
      exitCode: result.code,
      final: final.trim(),
      completedMessages,
      forbidden,
      completed: events.some((event) => event.type === "turn.completed"),
    };
    process.stdout.write(JSON.stringify(summary) + "\n");

    assert.equal(result.code, 0);
    assert.equal(summary.completed, true);
    assert.equal(summary.final, testCase.expectedFinal);
    assert.deepEqual(summary.completedMessages, [...testCase.expectedMessages]);
    assert.deepEqual(
      events.filter((event) => event.type === "item.completed" && event.item?.type === "reasoning")
        .map((event) => event.item?.text),
      testCase.name === "reasoning_message_overlap" ? ["PLAN_R1"] : [],
    );
    assert.deepEqual(summary.forbidden, []);
  }

  if (runToolHistoryCase) {
    const directory = join(root, "tool_history_overlap");
    const codexHome = join(directory, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model = "openai/gpt-native"',
        'model_provider = "token_replay"',
        "[model_providers.token_replay]",
        'name = "LuckyToken production lifecycle replay"',
        `base_url = "${tokenServer.origin}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
      ].join("\n"),
    );

    const firstCallId = "call_tool_a";
    const secondCallId = "call_tool_b";
    const firstItemId = "fc_tool_a";
    const secondItemId = "fc_tool_b";
    const firstArguments = JSON.stringify({ cmd: "Write-Output TOOL_A" });
    const secondArguments = JSON.stringify({ cmd: "Write-Output TOOL_B" });
    const firstCall = {
      type: "function_call",
      id: firstItemId,
      call_id: firstCallId,
      name: "exec_command",
      arguments: firstArguments,
      status: "completed",
    };
    const secondCall = {
      type: "function_call",
      id: secondItemId,
      call_id: secondCallId,
      name: "exec_command",
      arguments: secondArguments,
      status: "completed",
    };
    const firstCallOpen = { ...firstCall, arguments: "", status: "in_progress" };
    const secondCallOpen = { ...secondCall, arguments: "", status: "in_progress" };
    const firstResponse = [
      {
        type: "response.created",
        response: {
          id: "resp_tools_1",
          status: "in_progress",
          model: "gpt-native",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: reasoning("rs_tools", "in_progress"),
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 2,
        item_id: "rs_tools",
        summary_index: 0,
        delta: "TOOLS_REASONING",
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: firstCallOpen,
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: secondCallOpen,
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: reasoning("rs_tools", "completed", "TOOLS_REASONING"),
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: secondItemId,
        delta: secondArguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 1,
        item_id: secondItemId,
        arguments: secondArguments,
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: secondCall,
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: firstItemId,
        delta: firstArguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: firstItemId,
        arguments: firstArguments,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: firstCall,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_tools_1",
          object: "response",
          status: "completed",
          model: "gpt-native",
          output: [firstCall, secondCall],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      },
    ]
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");

    const finalMessage = message("msg_tool_final", "TOOLS_HISTORY_OK");
    const secondResponse = [
      {
        type: "response.created",
        response: {
          id: "resp_tools_2",
          status: "in_progress",
          model: "gpt-native",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: message("msg_tool_final", "", "in_progress"),
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_tool_final",
        content_index: 0,
        delta: "TOOLS_HISTORY_OK",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: finalMessage,
      },
      terminalFor([finalMessage]),
    ]
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");

    let toolStage = 0;
    let capturedSecondInput: Record<string, unknown>[] | undefined;
    providerResponder = async (request) => {
      const body = await request.text();
      if (toolStage === 0) {
        toolStage = 1;
        return new Response(firstResponse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      capturedSecondInput = (
        JSON.parse(body) as { input: Record<string, unknown>[] }
      ).input;
      toolStage = 2;
      return new Response(secondResponse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const output = join(directory, "final.txt");
    const result = await runCodex(
      [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-o",
        output,
        "Use both exec_command calls exactly as supplied by the model, then finish.",
      ],
      directory,
      codexHome,
    );
    const final = await readFile(output, "utf8").catch(() => "");
    const events = result.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
          };
        } catch {
          return {};
        }
      });
    const forbidden = FORBIDDEN.filter((diagnostic) =>
      result.stderr.includes(diagnostic),
    );
    const summary = {
      name: "tool_history_overlap",
      exitCode: result.code,
      final: final.trim(),
      forbidden,
      completed: events.some((event) => event.type === "turn.completed"),
      toolStage,
    };
    process.stdout.write(JSON.stringify(summary) + "\n");

    assert.equal(result.code, 0);
    assert.equal(summary.completed, true);
    assert.equal(summary.final, "TOOLS_HISTORY_OK");
    assert.equal(toolStage, 2);
    assert.deepEqual(forbidden, []);

    assert.ok(capturedSecondInput, "Codex must issue a second Responses request");
    const calls = capturedSecondInput.filter((item) => item.type === "function_call");
    assert.deepEqual(
      calls.map(({ call_id, name, arguments: args }) => ({ call_id, name, args })),
      [
        { call_id: secondCallId, name: "exec_command", args: secondArguments },
        { call_id: firstCallId, name: "exec_command", args: firstArguments },
      ],
    );
    const outputs = capturedSecondInput.filter(
      (item) => item.type === "function_call_output",
    );
    assert.deepEqual(
      outputs.map((item) => item.call_id),
      [secondCallId, firstCallId],
    );
    for (const [index, marker] of ["TOOL_B", "TOOL_A"].entries()) {
      const outputText = String(outputs[index]!.output);
      assert.match(outputText, new RegExp(marker));
      assert.ok(outputText.length > 0);
      assert.ok(
        capturedSecondInput.indexOf(outputs[index]!) >
          capturedSecondInput.indexOf(calls[index]!),
      );
    }
    const reasoningItems = capturedSecondInput.filter(
      (item) => item.type === "reasoning",
    );
    assert.equal(reasoningItems.length, 1);
    assert.equal(reasoningItems[0]!.id, "rs_tools");
    assert.deepEqual(reasoningItems[0]!.summary, [
      { type: "summary_text", text: "TOOLS_REASONING" },
    ]);
    assert.ok(
      capturedSecondInput.indexOf(reasoningItems[0]!) <
        capturedSecondInput.indexOf(calls[0]!),
    );
    providerResponder = undefined;
  }

  if (runPatchConsumerCase) {
    for (const mode of ["raw", "normalized"] as const) {
      const directory = join(root, `custom_tool_consumer_${mode}`);
      const codexHome = join(directory, "codex-home");
      await mkdir(codexHome, { recursive: true });
      const catalogPath = join(codexHome, "token-model-catalog.json");
      await writeFile(catalogPath, JSON.stringify({ models: [{
        slug: "openai/gpt-native", display_name: "Native replay",
        description: "Isolated custom apply_patch consumer fixture",
        base_instructions: "Apply the supplied patches.",
        supported_reasoning_levels: [], shell_type: "default",
        visibility: "list", supported_in_api: true, priority: 100,
        support_verbosity: false, truncation_policy: { mode: "tokens", limit: 65536 },
        supports_parallel_tool_calls: true, context_window: 200000,
        experimental_supported_tools: [], apply_patch_tool_type: "freeform",
      }] }));
      const calls = ["a", "b"].map((name) => ({
        type: "custom_tool_call", id: `ct_${name}`, call_id: `patch_${name}`,
        name: "apply_patch", status: "completed",
        input: `*** Begin Patch\n*** Add File: ${name}.txt\n+PATCH_${name.toUpperCase()}\n*** End Patch\n`,
      }));
      const [callA, callB] = calls;
      assert.ok(callA && callB);
      const open = (call: typeof callA, index: number) => ({
        type: "response.output_item.added", output_index: index,
        item: { ...call, input: "", status: "in_progress" },
      });
      const inputDelta = (call: typeof callA, index: number, tail: boolean) => ({
        type: "response.custom_tool_call_input.delta", output_index: index,
        item_id: call.id, call_id: call.call_id,
        delta: tail ? call.input.slice(call.input.indexOf("+PATCH")) : call.input.slice(0, call.input.indexOf("+PATCH")),
      });
      const finish = (call: typeof callA, index: number) => ({
        type: "response.output_item.done", output_index: index, item: call,
      });
      const render = (events: readonly Record<string, unknown>[]) => events.map((event, sequence_number) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
      const firstWire = render([
        open(callA, 0), open(callB, 1),
        inputDelta(callA, 0, false), inputDelta(callB, 1, false),
        inputDelta(callA, 0, true), finish(callA, 0),
        inputDelta(callB, 1, true), finish(callB, 1), terminalFor(calls),
      ]);
      const final = message("patch_final", "PATCH_CONSUMERS_OK");
      let stage = 0;
      providerResponder = async (request) => {
        const body = await request.json() as { input: Record<string, unknown>[]; tools: Record<string, unknown>[] };
        if (stage++ === 0) {
          assert.ok(body.tools.some((tool) => tool.type === "custom" && tool.name === "apply_patch"),
            "Codex must register the real freeform apply_patch tool");
          return new Response(firstWire, { headers: { "content-type": "text/event-stream" } });
        }
        assert.deepEqual(body.input.filter((item) => item.type === "custom_tool_call")
          .map(({ call_id, name, input }) => ({ call_id, name, input })),
        calls.map(({ call_id, name, input }) => ({ call_id, name, input })));
        const outputs = body.input.filter((item) => item.type === "custom_tool_call_output");
        assert.deepEqual(outputs.map((item) => item.call_id), ["patch_a", "patch_b"]);
        // Consumer diffs are emitted before tool execution. Deliberately deny
        // writes in both controls; successful execution is covered by the
        // separate function-tool history case, not needed for this consumer.
        assert.ok(outputs.every((item) => String(item.output).includes("read-only sandbox")));
        return new Response(render([added(final, 0), done(final, 0), terminalFor([final])]),
          { headers: { "content-type": "text/event-stream" } });
      };
      // The raw control uses a local fixture HTTP endpoint. The treatment uses
      // Token's production Provider Native HTTP handler, including normalization.
      const rawServer = mode === "raw" ? await startTokenHttpServer({
        runtime: createTokenRuntime({ clientProtocols: [{
          method: "POST", pathname: "/v1/responses",
          handle: async (request) => {
            try { return await providerResponder!(request); }
            catch (error) {
              process.stderr.write(String(error) + "\n");
              throw error;
            }
          },
        }] }), port: 0,
      }) : undefined;
      try {
        await writeFile(join(codexHome, "config.toml"), [
          'model = "openai/gpt-native"', 'model_provider = "token_replay"',
          `model_catalog_json = ${JSON.stringify(catalogPath)}`,
          'features.apply_patch_streaming_events = true',
          '[model_providers.token_replay]', 'name = "Local consumer replay"',
          `base_url = "${rawServer?.origin ?? tokenServer.origin}/v1"`,
          'wire_api = "responses"', 'requires_openai_auth = false',
        ].join("\n"));
        const result = await replayCodexPatchConsumers(cli, directory, codexHome);
        const diffs = result.updates.map((update) => ({
          callId: update.itemId,
          changes: update.changes as { path: string; diff: string }[],
        }));
        const attributed = calls.every((call, index) => diffs.some((update) =>
          update.callId === call.call_id && update.changes.some((change) =>
            change.path === `${index === 0 ? "a" : "b"}.txt` &&
            change.diff === `PATCH_${index === 0 ? "A" : "B"}\n`)));
        assert.equal(attributed, mode === "normalized", "raw control must lose consumer attribution; normalized must preserve both diffs");
        if (mode === "normalized") {
          for (const update of diffs) {
            const name = update.callId === "patch_a" ? "a" : "b";
            assert.ok(update.callId === "patch_a" || update.callId === "patch_b");
            assert.ok(update.changes.every((change) => change.path === `${name}.txt` &&
              `PATCH_${name.toUpperCase()}\n`.startsWith(change.diff)));
          }
        }
        for (const name of ["a", "b"]) {
          await assert.rejects(readFile(join(directory, `${name}.txt`)), { code: "ENOENT" });
        }
        assert.equal(stage, 2);
        assert.deepEqual(FORBIDDEN.filter((diagnostic) => result.stderr.includes(diagnostic)), []);
        process.stdout.write(JSON.stringify({ name: `custom_tool_consumer_${mode}`, diffs, attributed, completed: true }) + "\n");
      } finally {
        await rawServer?.close();
        providerResponder = undefined;
      }
    }
  }

  assert.equal(
    providerRequests,
    selectedCases.length + (runToolHistoryCase ? 2 : 0) + (runPatchConsumerCase ? 2 : 0),
  );
} finally {
  await tokenServer?.close();
  const cleanup = resolve(root);
  const insideTemp = relative(resolve(tmpdir()), cleanup);
  assert.ok(insideTemp && !insideTemp.startsWith("..") && !isAbsolute(insideTemp));
  await rm(cleanup, { recursive: true, force: true });
}
